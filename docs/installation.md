# Installation

## Requirements

- **Node.js**: `v24.0.0` or higher
- **Runtime Dependencies**: `@stellar/stellar-sdk` (`^17.0.1`)

## Installing from NPM

```bash
npm install stellar-agent-guard-sdk
```

## Installing from Source

```bash
git clone https://github.com/aigbagbobila/stellar-agent-guard-sdk.git
cd stellar-agent-guard-sdk
npm ci
npm run build
npm test
```

The SDK uses Node 24 native TypeScript test execution (`node --test`) and compiles to modern ESM (`dist/index.js`).
