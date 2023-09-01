import { version } from "../../index.js";
import { convexToJson, Value } from "../../values/index.js";
import { createHybridErrorStacktrace, logFatalError } from "../logging.js";
import { LocalSyncState } from "./local_state.js";
import { RequestManager } from "./request_manager.js";
import {
  OptimisticLocalStore,
  OptimisticUpdate,
} from "./optimistic_updates.js";
import {
  OptimisticQueryResults,
  QueryResultsMap,
} from "./optimistic_updates_impl.js";
import {
  ActionRequest,
  MutationRequest,
  QueryId,
  QueryJournal,
  RequestId,
  ServerMessage,
  TS,
  UserIdentityAttributes,
} from "./protocol.js";
import { RemoteQuerySet } from "./remote_query_set.js";
import { QueryToken, serializePathAndArgs } from "./udf_path_utils.js";
import { ReconnectMetadata, WebSocketManager } from "./web_socket_manager.js";
import { newSessionId } from "./session.js";
import { FunctionResult } from "./function_result.js";
import {
  AuthenticationManager,
  AuthTokenFetcher,
} from "./authentication_manager.js";
export { type AuthTokenFetcher } from "./authentication_manager.js";
import { getMarksReport, mark, MarkName } from "./metrics.js";
import { parseArgs, validateDeploymentUrl } from "../../common/index.js";

/**
 * Options for {@link BaseConvexClient}.
 *
 * @public
 */
export interface ClientOptions {
  /**
   * Whether to prompt the user if they have unsaved changes pending
   * when navigating away or closing a web page.
   *
   * This is only possible when the `window` object exists, i.e. in a browser.
   *
   * The default value is `true` in browsers.
   */
  unsavedChangesWarning?: boolean;
  /**
   * Specifies an alternate
   * [WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)
   * constructor to use for client communication with the Convex cloud.
   * The default behavior is to use `WebSocket` from the global environment.
   */
  webSocketConstructor?: typeof WebSocket;
  /**
   * Adds additional logging for debugging purposes.
   *
   * The default value is `false`.
   */
  verbose?: boolean;
  /**
   * Sends additional metrics to Convex for debugging purposes.
   *
   * The default value is `false`.
   */
  reportDebugInfoToConvex?: boolean;
}

/**
 * State describing the client's connection with the Convex backend.
 *
 * @public
 */
export type ConnectionState = {
  hasInflightRequests: boolean;
  isWebSocketConnected: boolean;
  timeOfOldestInflightRequest: Date | null;
};

/**
 * Options for {@link BaseConvexClient.subscribe}.
 *
 * @public
 */
export interface SubscribeOptions {
  /**
   * An (optional) journal produced from a previous execution of this query
   * function.
   *
   * If there is an existing subscription to a query function with the same
   * name and arguments, this journal will have no effect.
   */
  journal?: QueryJournal;
}

/**
 * Options for {@link BaseConvexClient.mutation}.
 *
 * @public
 */
export interface MutationOptions {
  /**
   * An optimistic update to apply along with this mutation.
   *
   * An optimistic update locally updates queries while a mutation is pending.
   * Once the mutation completes, the update will be rolled back.
   */
  optimisticUpdate?: OptimisticUpdate<any>;
}

/**
 * Low-level client for directly integrating state management libraries
 * with Convex.
 *
 * Most developers should use higher level clients, like
 * the {@link ConvexHttpClient} or the React hook based {@link react.ConvexReactClient}.
 *
 * @public
 */
export class BaseConvexClient {
  private readonly address: string;
  private readonly state: LocalSyncState;
  private readonly requestManager: RequestManager;
  private readonly webSocketManager: WebSocketManager;
  private readonly authenticationManager: AuthenticationManager;
  private remoteQuerySet: RemoteQuerySet;
  private readonly optimisticQueryResults: OptimisticQueryResults;
  private readonly onTransition: (updatedQueries: QueryToken[]) => void;
  private nextRequestId: RequestId;
  private readonly sessionId: string;
  private fetchToken: null | AuthTokenFetcher = null;
  private refetchTokenTimeoutId: null | ReturnType<typeof setTimeout> = null;
  private firstMessageReceived = false;
  private readonly verbose: boolean;
  private readonly debug: boolean;
  private maxObservedTimestamp: TS | undefined;

  /**
   * @param address - The url of your Convex deployment, often provided
   * by an environment variable. E.g. `https://small-mouse-123.convex.cloud`.
   * @param onTransition - A callback receiving an array of query tokens
   * corresponding to query results that have changed.
   * @param options - See {@link ClientOptions} for a full description.
   */
  constructor(
    address: string,
    onTransition: (updatedQueries: QueryToken[]) => void,
    options?: ClientOptions
  ) {
    if (typeof address === "object") {
      throw new Error(
        "Passing a ClientConfig object is no longer supported. Pass the URL of the Convex deployment as a string directly."
      );
    }
    validateDeploymentUrl(address);
    options = { ...options };
    let webSocketConstructor = options.webSocketConstructor;
    if (!webSocketConstructor && typeof WebSocket === "undefined") {
      throw new Error(
        "No WebSocket global variable defined! To use Convex in an environment without WebSocket try the HTTP client: https://docs.convex.dev/api/classes/browser.ConvexHttpClient"
      );
    }
    webSocketConstructor = webSocketConstructor || WebSocket;
    this.verbose = options.verbose ?? false;
    this.debug = options.reportDebugInfoToConvex ?? false;
    this.address = address;

    // Substitute http(s) with ws(s)
    const i = address.search("://");
    if (i === -1) {
      throw new Error("Provided address was not an absolute URL.");
    }
    const origin = address.substring(i + 3); // move past the double slash
    const protocol = address.substring(0, i);
    let wsProtocol;
    if (protocol === "http") {
      wsProtocol = "ws";
    } else if (protocol === "https") {
      wsProtocol = "wss";
    } else {
      throw new Error(`Unknown parent protocol ${protocol}`);
    }
    const wsUri = `${wsProtocol}://${origin}/api/${version}/sync`;

    this.state = new LocalSyncState();
    this.remoteQuerySet = new RemoteQuerySet((queryId) =>
      this.state.queryPath(queryId)
    );
    this.requestManager = new RequestManager();
    this.authenticationManager = new AuthenticationManager(this.state, {
      authenticate: (token) => {
        const message = this.state.setAuth(token);
        this.webSocketManager.sendMessage(message);
      },
      pauseSocket: () => this.webSocketManager.pause(),
      resumeSocket: () => this.webSocketManager.resume(),
      clearAuth: () => {
        this.clearAuth();
      },
      verbose: this.verbose,
    });
    this.optimisticQueryResults = new OptimisticQueryResults();
    this.onTransition = onTransition;
    this.nextRequestId = 0;
    this.sessionId = newSessionId();

    const { unsavedChangesWarning } = options;
    if (
      typeof window === "undefined" ||
      typeof window.addEventListener === "undefined"
    ) {
      if (unsavedChangesWarning === true) {
        throw new Error(
          "unsavedChangesWarning requested, but window.addEventListener not found! Remove {unsavedChangesWarning: true} from Convex client options."
        );
      }
    } else if (unsavedChangesWarning !== false) {
      // Listen for tab close events and notify the user on unsaved changes.
      window.addEventListener("beforeunload", (e) => {
        if (this.requestManager.hasIncompleteRequests()) {
          // There are 3 different ways to trigger this pop up so just try all of
          // them.

          e.preventDefault();
          // This confirmation message doesn't actually appear in most modern
          // browsers but we tried.
          const confirmationMessage =
            "Are you sure you want to leave? Your changes may not be saved.";
          (e || window.event).returnValue = confirmationMessage;
          return confirmationMessage;
        }
      });
    }

    this.webSocketManager = new WebSocketManager(
      wsUri,
      (reconnectMetadata: ReconnectMetadata) => {
        // We have a new WebSocket!
        this.mark("convexWebSocketOpen");
        this.webSocketManager.sendMessage({
          ...reconnectMetadata,
          type: "Connect",
          sessionId: this.sessionId,
          maxObservedTimestamp: this.maxObservedTimestamp,
        });

        // Throw out our remote query, reissue queries
        // and outstanding mutations, and reauthenticate.
        this.remoteQuerySet = new RemoteQuerySet((queryId) =>
          this.state.queryPath(queryId)
        );
        const [querySetModification, authModification] = this.state.restart();
        if (authModification) {
          this.webSocketManager.sendMessage(authModification);
        }
        this.webSocketManager.sendMessage(querySetModification);
        for (const message of this.requestManager.restart()) {
          this.webSocketManager.sendMessage(message);
        }
      },
      (serverMessage: ServerMessage) => {
        // Metrics events grow linearly with reconnection attempts so this
        // conditional prevents n^2 metrics reporting.
        if (!this.firstMessageReceived) {
          this.firstMessageReceived = true;
          this.mark("convexFirstMessageReceived");
          this.reportMarks();
        }
        switch (serverMessage.type) {
          case "Transition": {
            this.observedTimestamp(serverMessage.endVersion.ts);
            this.authenticationManager.onTransition(serverMessage);
            this.remoteQuerySet.transition(serverMessage);
            this.state.saveQueryJournals(serverMessage);
            const completedRequests = this.requestManager.removeCompleted(
              this.remoteQuerySet.timestamp()
            );
            this.notifyOnQueryResultChanges(completedRequests);
            break;
          }
          case "MutationResponse": {
            if (serverMessage.success) {
              this.observedTimestamp(serverMessage.ts);
            }
            const completedMutationId =
              this.requestManager.onResponse(serverMessage);
            if (completedMutationId) {
              this.notifyOnQueryResultChanges(new Set([completedMutationId]));
            }
            break;
          }
          case "ActionResponse": {
            this.requestManager.onResponse(serverMessage);
            break;
          }
          case "AuthError": {
            this.authenticationManager.onAuthError(serverMessage);
            break;
          }
          case "FatalError": {
            const error = logFatalError(serverMessage.error);
            void this.webSocketManager.stop();
            throw error;
          }
          case "Ping":
            break; // do nothing
          default: {
            const _typeCheck: never = serverMessage;
          }
        }
      },
      webSocketConstructor,
      this.verbose
    );
    this.mark("convexClientConstructed");
  }

  private observedTimestamp(observedTs: TS) {
    if (
      this.maxObservedTimestamp === undefined ||
      this.maxObservedTimestamp.lessThanOrEqual(observedTs)
    ) {
      this.maxObservedTimestamp = observedTs;
    }
  }

  getMaxObservedTimestamp() {
    return this.maxObservedTimestamp;
  }

  /**
   * Compute the current query results based on the remoteQuerySet and the
   * current optimistic updates and call `onTransition` for all the changed
   * queries.
   *
   * @param completedMutations - A set of mutation IDs whose optimistic updates
   * are no longer needed.
   */
  private notifyOnQueryResultChanges(completedRequest: Set<RequestId>) {
    const remoteQueryResults: Map<QueryId, FunctionResult> =
      this.remoteQuerySet.remoteQueryResults();
    const queryTokenToValue: QueryResultsMap = new Map();
    for (const [queryId, result] of remoteQueryResults) {
      const queryToken = this.state.queryToken(queryId);
      // It's possible that we've already unsubscribed to this query but
      // the server hasn't learned about that yet. If so, ignore this one.

      if (queryToken !== null) {
        const query = {
          result,
          udfPath: this.state.queryPath(queryId)!,
          args: this.state.queryArgs(queryId)!,
        };
        queryTokenToValue.set(queryToken, query);
      }
    }

    this.onTransition(
      this.optimisticQueryResults.ingestQueryResultsFromServer(
        queryTokenToValue,
        completedRequest
      )
    );
  }

  setAuth(
    fetchToken: AuthTokenFetcher,
    onChange: (isAuthenticated: boolean) => void
  ) {
    void this.authenticationManager.setConfig(fetchToken, onChange);
  }

  hasAuth() {
    return this.state.hasAuth();
  }

  /** @internal */
  setAdminAuth(value: string, fakeUserIdentity?: UserIdentityAttributes) {
    const message = this.state.setAdminAuth(value, fakeUserIdentity);
    this.webSocketManager.sendMessage(message);
  }

  clearAuth() {
    const message = this.state.clearAuth();
    this.webSocketManager.sendMessage(message);
  }

  /**
   * Subscribe to a query function.
   *
   * Whenever this query's result changes, the `onTransition` callback
   * passed into the constructor will be called.
   *
   * @param name - The name of the query.
   * @param args - An arguments object for the query. If this is omitted, the
   * arguments will be `{}`.
   * @param options - A {@link SubscribeOptions} options object for this query.

   * @returns An object containing a {@link QueryToken} corresponding to this
   * query and an `unsubscribe` callback.
   */
  subscribe(
    name: string,
    args?: Record<string, Value>,
    options?: SubscribeOptions
  ): { queryToken: QueryToken; unsubscribe: () => void } {
    const argsObject = parseArgs(args);

    const { modification, queryToken, unsubscribe } = this.state.subscribe(
      name,
      argsObject,
      options?.journal
    );
    if (modification !== null) {
      this.webSocketManager.sendMessage(modification);
    }
    return {
      queryToken,
      unsubscribe: () => {
        const modification = unsubscribe();
        if (modification) {
          this.webSocketManager.sendMessage(modification);
        }
      },
    };
  }

  /**
   * A query result based only on the current, local state.
   *
   * The only way this will return a value is if we're already subscribed to the
   * query or its value has been set optimistically.
   */
  localQueryResult(
    udfPath: string,
    args?: Record<string, Value>
  ): Value | undefined {
    const argsObject = parseArgs(args);
    const queryToken = serializePathAndArgs(udfPath, argsObject);
    return this.optimisticQueryResults.queryResult(queryToken);
  }

  /**
   * @internal
   */
  localQueryLogs(
    udfPath: string,
    args?: Record<string, Value>
  ): string[] | undefined {
    const argsObject = parseArgs(args);
    const queryToken = serializePathAndArgs(udfPath, argsObject);
    return this.optimisticQueryResults.queryLogs(queryToken);
  }

  /**
   * Retrieve the current {@link QueryJournal} for this query function.
   *
   * If we have not yet received a result for this query, this will be `undefined`.
   *
   * @param name - The name of the query.
   * @param args - The arguments object for this query.
   * @returns The query's {@link QueryJournal} or `undefined`.
   */
  queryJournal(
    name: string,
    args?: Record<string, Value>
  ): QueryJournal | undefined {
    const argsObject = parseArgs(args);
    const queryToken = serializePathAndArgs(name, argsObject);
    return this.state.queryJournal(queryToken);
  }

  /**
   * Get the current {@link ConnectionState} between the client and the Convex
   * backend.
   *
   * @returns The {@link ConnectionState} with the Convex backend.
   */
  connectionState(): ConnectionState {
    return {
      hasInflightRequests: this.requestManager.hasInflightRequests(),
      isWebSocketConnected: this.webSocketManager.socketState() === "ready",
      timeOfOldestInflightRequest:
        this.requestManager.timeOfOldestInflightRequest(),
    };
  }

  /**
   * Execute a mutation function.
   *
   * @param name - The name of the mutation.
   * @param args - An arguments object for the mutation. If this is omitted,
   * the arguments will be `{}`.
   * @param options - A {@link MutationOptions} options object for this mutation.

   * @returns - A promise of the mutation's result.
   */
  async mutation(
    name: string,
    args?: Record<string, Value>,
    options?: MutationOptions
  ): Promise<any> {
    const result = await this.mutationInternal(name, args, options);
    if (!result.success) {
      throw new Error(createHybridErrorStacktrace("mutation", name, result));
    }
    return result.value;
  }

  /**
   * @internal
   */
  async mutationInternal(
    udfPath: string,
    args?: Record<string, Value>,
    options?: MutationOptions
  ): Promise<FunctionResult> {
    const mutationArgs = parseArgs(args);
    this.tryReportLongDisconnect();
    const requestId = this.nextRequestId;
    this.nextRequestId++;

    if (options !== undefined) {
      const optimisticUpdate = options.optimisticUpdate;
      if (optimisticUpdate !== undefined) {
        const wrappedUpdate = (localQueryStore: OptimisticLocalStore) => {
          optimisticUpdate(localQueryStore, mutationArgs);
        };

        const changedQueries =
          this.optimisticQueryResults.applyOptimisticUpdate(
            wrappedUpdate,
            requestId
          );
        this.onTransition(changedQueries);
      }
    }

    const message: MutationRequest = {
      type: "Mutation",
      requestId,
      udfPath,
      args: [convexToJson(mutationArgs)],
    };
    const mightBeSent = this.webSocketManager.sendMessage(message);
    return this.requestManager.request(message, mightBeSent);
  }

  /**
   * Execute an action function.
   *
   * @param name - The name of the action.
   * @param args - An arguments object for the action. If this is omitted,
   * the arguments will be `{}`.
   * @returns A promise of the action's result.
   */
  async action(name: string, args?: Record<string, Value>): Promise<any> {
    const result = await this.actionInternal(name, args);
    if (!result.success) {
      throw new Error(createHybridErrorStacktrace("action", name, result));
    }
    return result.value;
  }

  /**
   * @internal
   */
  async actionInternal(
    udfPath: string,
    args?: Record<string, Value>
  ): Promise<FunctionResult> {
    const actionArgs = parseArgs(args);
    const requestId = this.nextRequestId;
    this.nextRequestId++;
    this.tryReportLongDisconnect();

    const message: ActionRequest = {
      type: "Action",
      requestId,
      udfPath,
      args: [convexToJson(actionArgs)],
    };

    const mightBeSent = this.webSocketManager.sendMessage(message);
    return this.requestManager.request(message, mightBeSent);
  }

  /**
   * Close any network handles associated with this client and stop all subscriptions.
   *
   * Call this method when you're done with an {@link BaseConvexClient} to
   * dispose of its sockets and resources.
   *
   * @returns A `Promise` fulfilled when the connection has been completely closed.
   */
  async close(): Promise<void> {
    this.authenticationManager.stop();
    return this.webSocketManager.stop();
  }

  private _logVerbose(message: string) {
    if (this.verbose) {
      console.debug(`${new Date().toISOString()} ${message}`);
    }
  }

  // Instance property so that `mark()` doesn't need to be called as a method.
  private mark = (name: MarkName) => {
    if (this.debug) {
      mark(name, this.sessionId);
    }
  };

  /**
   * Reports performance marks to the server. This should only be called when
   * we have a functional websocket.
   */
  private reportMarks() {
    if (this.debug) {
      const report = getMarksReport(this.sessionId);
      this.webSocketManager.sendMessage({
        type: "Event",
        eventType: "ClientConnect",
        event: report,
      });
    }
  }

  private tryReportLongDisconnect() {
    if (!this.debug) {
      return;
    }
    const timeOfOldestRequest =
      this.connectionState().timeOfOldestInflightRequest;
    if (
      timeOfOldestRequest === null ||
      Date.now() - timeOfOldestRequest.getTime() <= 60 * 1000
    ) {
      return;
    }
    const endpoint = `${this.address}/api/debug_event`;
    fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Convex-Client": `npm-${version}`,
      },
      body: JSON.stringify({ event: "LongWebsocketDisconnect" }),
    })
      .then((response) => {
        if (!response.ok) {
          console.warn(
            "Analytics request failed with response:",
            response.body
          );
        }
      })
      .catch((error) => {
        console.warn("Analytics response failed with error:", error);
      });
  }
}
