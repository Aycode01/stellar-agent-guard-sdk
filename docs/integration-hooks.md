# Integration hooks — what each agent framework actually exposes

This document records the **real** interception points the SDK's framework adapters
are built against, read from each framework's own source rather than from its
documentation or from an assumed API shape.

Every entry below is pinned to the file revision it was read from (blob SHA), so a
reader can confirm the signatures have not drifted under them. Read 2026-09-14.

**Summary**

| Framework | Pre-execution blocking hook | Status |
|---|---|---|
| LangChain | `AgentMiddleware.wrap_tool_call` | **Confirmed** |
| ElizaOS | `Action.validate` | **Confirmed** |
| AutoGPT | none exposed to third parties | **Confirmed absent** — see §3 |

The rule this document enforces: a framework gets an adapter only if a genuine
pre-execution *blocking* point exists. Observability-only callbacks are not
sufficient — they can watch a spend, not stop one. Where no hook exists, the gap is
recorded here rather than papered over with an adapter built on a guessed interface.

---

## 1. LangChain — `AgentMiddleware.wrap_tool_call`

**Source:** `langchain-ai/langchain`, `master`, `libs/langchain_v1/langchain/agents/middleware/types.py`
(blob `b7d5b8050ab8`).

### The hook

```python
class AgentMiddleware(Generic[StateT, ContextT, InputT, OutputT]):
    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command[Any]],
    ) -> ToolMessage | Command[Any]:
        """Intercept tool execution for retries, monitoring, or modification.

        Async version is `awrap_tool_call`

        Multiple middleware compose automatically (first defined = outermost).

        Exceptions propagate unless `handle_tool_errors` is configured on `ToolNode`.
        ...
```

The async variant is declared on the same class:

```python
    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command[Any]]],
    ) -> ToolMessage | Command[Any]:
```

`ToolCallRequest` is re-exported by that module and defined in `langgraph`:
`langchain-ai/langgraph`, `main`, `libs/prebuilt/langgraph/prebuilt/tool_node.py`
(blob `95e161b9078e`):

```python
@dataclass
class ToolCallRequest:
    """Tool execution request passed to tool call interceptors.

    Attributes:
        tool_call: Tool call dict with name, args, and id from model output.
        tool: BaseTool instance to be invoked, or None if tool is not
            registered with the `ToolNode`. ...
        state: Agent state (`dict`, `list`, or `BaseModel`).
        runtime: LangGraph runtime context (optional, `None` if outside graph).
    """

    tool_call: ToolCall
    tool: BaseTool | None
```

and the wrapper type:

```python
ToolCallWrapper = Callable[
    [ToolCallRequest, Callable[[ToolCallRequest], ToolMessage | Command]],
    ToolMessage | Command,
]
```

The same module also exposes a decorator form, for a function instead of a class:

```python
@overload
def wrap_tool_call(
    func: None = None,
    *,
    state_schema: type[StateT] | None = None,
    tools: list[BaseTool] | None = None,
    name: str | None = None,
) -> Callable[[_CallableReturningToolResponse], AgentMiddleware[StateT, ContextT]]: ...
```

### Why this is genuinely blockable, not observability-only

The handler *is* the continuation: `WrapToolCall` receives the tool execution as a
callback and decides whether to invoke it. A middleware that returns a
`ToolMessage` **without calling `handler(request)`** means the tool body never runs.
Returning a `Command` can additionally redirect the graph. This is the property the
adapter depends on: the guard's block decision is turned into a returned
`ToolMessage` describing the refusal, and the underlying tool — the one that would
have signed and broadcast a transaction — is never entered.

Composition order matters and is documented in the source: *"first defined =
outermost"*, so the interceptor is registered ahead of any other tool middleware.

### What the adapter must do

Build an `AgentMiddleware` (or a `@wrap_tool_call`-decorated function) that:

1. inspects `request.tool_call["args"]` for the transaction intent;
2. asks the guard's pre-flight interceptor whether the action is permitted;
3. on **block**, returns a `ToolMessage` carrying `GuardBlockedError`'s reason and
   explanation, **without** calling `handler(request)`;
4. on **allow**, calls `handler(request)` and returns its result unchanged.

---

## 2. ElizaOS — `Action.validate`

**Source:** `elizaOS/eliza`, `develop`. `packages/core/src/types/components.ts`
(blob `5f604e593854`) and `packages/core/src/runtime.ts` (blob `eb3f3fc98cef`).

### The hook types

```typescript
export type Validator = (
	runtime: IAgentRuntime,
	message: Memory,
	state?: State,
	options?: HandlerOptions | Record<string, JsonValue | undefined>,
) => Promise<boolean>;

export type Handler = (
	runtime: IAgentRuntime,
	message: Memory,
	state?: State,
	options?: HandlerOptions | Record<string, JsonValue | undefined>,
	callback?: HandlerCallback,
	responses?: Memory[],
) => Promise<ActionResult | undefined>;
```

Both hang off the `Action` interface, whose own doc comment calls it
"`Action` (validate + handler)":

```typescript
export interface Action {
	/** Action name */
	name: string;

	/** Detailed description */
	description: string;
	...
	/** Handler function */
	handler: Handler;

	/** Validation function */
	validate: Validator;
```

### Where the gate actually fires

`runtime.ts` calls `validate` and admits the action to the eligible set only when it
returns truthy:

```typescript
				try {
					const ok = await action.validate(this, message, state);
					if (ok) validated.push(action);
				} catch (err) {
					// error-policy:J4 Mode actions are isolated; failed validation is
					// reported while independent actions remain eligible.
```

The same `action.validate(` gate is used from the other execution paths as well —
`packages/core/src/services/message/action-surface.ts` and
`packages/core/src/runtime/execute-planned-tool-call.ts` — so a false verdict keeps
the handler from running whether the action was chosen by the planner or by a
planned tool call.

### Why this is genuinely blockable, not observability-only

An action whose `validate` returns `false` is filtered out of the candidate list
*before* any handler is invoked. `validate` is called with the same
`(runtime, message, state)` triple the handler gets, so it has everything needed to
classify the intended action. This composes with the guard rather than replacing
it: `validate` is where the pre-flight check is performed, so the handler that
submits the transaction is never reached.

### What the adapter must do

Compose the guard check into `validate` rather than wrapping `handler`:

```typescript
validate: async (runtime, message, state, options) => {
  if (!(await baseValidate(runtime, message, state, options))) return false;
  const decision = await guard.preflight(intentFrom(message, state, options));
  return decision.allowed; // false ⇒ action never executes
}
```

Note the ordering consequence, stated plainly: because a blocked action is simply
never validated, the refusal surfaces through whatever the runtime does with a
non-matching action set, not as an error thrown from the handler. The adapter
therefore also records the block on the telemetry listener (see
[`docs/event-schema.md`](./event-schema.md), which records the real event topics
verified against the live chain) so a refused action is auditable rather than
silent.

---

## 3. AutoGPT — **no third-party pre-execution blocking hook**

This entry is the resolution of an open question, not an assumption. The finding is
negative and is recorded as such.

**Source:** `Significant-Gravitas/AutoGPT`, `master`.

- `autogpt_platform/backend/backend/executor/manager.py` (blob `713459246689`)
- `autogpt_platform/backend/backend/blocks/_base.py` (blob `78ee11373050`)
- `autogpt_platform/backend/backend/executor/automod/manager.py`

### What was checked

**1. Is there a middleware/hook/interceptor registry in the executor?** No. Grepping
the executor's `manager.py` for `hook`, `middleware`, `interceptor`, and
`register.*callback` returns nothing, and block execution is a direct call:

```python
            block_iter = node_block.execute(input_data, **extra_exec_kwargs)
```

There is no registry a guardrail library could join, and no callback list consulted
before execution.

**2. Is there a pre-execution gate inside the block lifecycle?** Yes, but it is not
available to third parties. `Block._execute` consults a review step before `run`:

```python
    async def _execute(
        self,
        input_data: BlockInput,
        *,
        execution_context: "ExecutionContext",
        **kwargs,
    ) -> BlockOutput:
        # Review is only meaningful inside a graph execution. Direct block
        # execution (e.g. from the /blocks/{id}/execute API) has no graph
        # context and skips the review path.
        if execution_context.graph_exec_id is not None:
            should_pause, input_data = await self.is_block_exec_need_review(
                input_data, execution_context=execution_context, **kwargs
```

and the gate itself:

```python
    async def is_block_exec_need_review(
        self,
        input_data: BlockInput,
        *,
        user_id: str,
        node_id: str,
        node_exec_id: str,
        graph_exec_id: str,
        graph_id: str,
        graph_version: int,
        execution_context: "ExecutionContext",
        is_graph_execution: bool = True,
        **kwargs,
    ) -> tuple[bool, BlockInput]:
        """
        Check if this block execution needs human review and handle the review process.

        Returns:
            Tuple of (should_pause, input_data_to_use)
            - should_pause: True if execution should be paused for review
            - input_data_to_use: The input data to use (may be modified by reviewer)
        """
        if not (
            self.is_sensitive_action and execution_context.sensitive_action_safe_mode
        ):
            return False, input_data
```

This is a real pre-execution pause — but it is **not an extension point**:

- it is a method on the platform's own `Block` base class, so intervening in it
  means patching or forking the platform, not registering with it;
- it only engages when the *block author* has set `is_sensitive_action` and the
  execution context is in safe mode;
- it is a human-in-the-loop review pause, not a policy engine a library can supply
  a verdict to.

**3. Is the AutoMod path an interception point?** No.
`AutoModManager.moderate_graph_execution_inputs` moderates a graph's *inputs* before
a run. It is internal, feature-flagged per user, configuration-driven (it calls an
external moderation API configured through platform settings), and surfaces failures
as the platform's own `ModerationError`. It is not a hook a third-party package can
register a policy into.

### Conclusion and the honest options

**AutoGPT has no pluggable pre-execution blocking hook for third-party guardrails as
of this revision.** No adapter will be built against a guessed shape.

The two viable integrations are, in order of preference:

1. **Author the block that performs the guarded action.** Blocks are AutoGPT's
   supported extension mechanism: a `Block` subclass implements
   `async def run(self, input_data, **kwargs) -> BlockOutput` (an `@abstractmethod`,
   `_base.py`), and a guard-owned block owns that call. This gives enforcement, but
   with a real limitation worth stating: it only protects actions that flow through
   *that* block. It cannot constrain an unrelated block that someone else authored,
   so it is ownership rather than interception.
2. **Upstream a hook at the point that already exists.** `is_block_exec_need_review`
   is called immediately before `run` and already models "pause or proceed with
   possibly-modified input". A pluggable, non-human policy check at that call site
   is the natural upstream change, and it would give third-party guardrails the same
   standing the internal review path already has. This is a contribution to AutoGPT,
   not something this SDK can build against today.

**Consequence for this SDK:** the AutoGPT adapter is not built. It is listed as an
open gap, and it should be revisited either when AutoGPT exposes a pre-execution
hook or when the project deliberately chooses option 1 as its AutoGPT integration
story.

### Re-verification

If AutoGPT's executor gains a middleware mechanism, this section should be
re-checked by repeating the three searches above against the then-current
`executor/manager.py` and `blocks/_base.py`, and the blob SHAs here superseded
rather than silently replaced.
