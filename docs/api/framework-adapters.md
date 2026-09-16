# Framework Adapters API

The SDK provides plug-and-play middleware for AI agent orchestration frameworks.

## LangChain

```ts
import { createLangChainGuardMiddleware } from "stellar-agent-guard-sdk";

const middleware = createLangChainGuardMiddleware({
  interceptor,
  toContractCall: (request) => ({
    contractId: request.args.contractId,
    method: request.args.method,
    args: request.args.args,
  }),
});
```

Halts execution by returning without calling `handler(request)` if the interceptor blocks the planned action.

## ElizaOS

```ts
import { createGuardValidator } from "stellar-agent-guard-sdk";

const validate = createGuardValidator({
  interceptor,
  toContractCall: (message) => ({
    contractId: message.content.contractId,
    method: message.content.method,
    args: message.content.args,
  }),
});
```

Returns `false` from the action validator if the interceptor refuses the call, filtering the action out before execution.
