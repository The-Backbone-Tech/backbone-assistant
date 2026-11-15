# Use a model on this computer

Start Ollama or LM Studio separately and load a model that supports the task. No model
is downloaded or server started by the app. Their maintained
[Ollama](https://docs.ollama.com/api/openai-compatibility) and
[LM Studio](https://lmstudio.ai/docs/developer/openai-compat) OpenAI-compatible endpoints
supply the model list and chat completion API; model licences remain their own.

Open Settings → AI and models → Local models. Detection asks only 127.0.0.1, on port
11434 for Ollama and 1234 for LM Studio (also the existing llama.cpp and vLLM defaults).
Use Look again to repeat detection, then click a model. A local route carries no key.
The active connection says which model will run. Your chosen local model takes priority
over stored own, gateway and Keychain credentials until you clear the local selection.
An invalid stored local setting refuses with a repair message instead of selecting a paid route. Pi must be the selected engine; native agents choose their own connections.

Send a message, inspect its result and continue after reopening the app: the selected
route is stored in the same data folder as other model settings. If the server stops or refuses
the model, the turn fails with a message naming the address it tried and three things to check:
the address path (usually `/v1`), that the server is running, and that the model is loaded. It keeps that selected route
and never silently tries a different server or a paid connection. Start the server again
and send a new turn when ready. A cut-off stream remains an unfinished answer.

These focused tests need no account, key or real model server:

```bash test
node scripts/no-leftovers.mjs node --test packages/modules/harness-pi/test/local-endpoint.test.ts
```

The installed desktop journey uses fake loopback servers at both default ports. Its proof
is `packages/surfaces/app/e2e/local-models.electron.spec.ts`; it checks selection, useful
replies, restart persistence and stopped-server refusal without reaching the other server.
The fixture also reserves detection ports 8080 and 8000 with owned refusals, so it cannot
inspect a person's other model server. All four ports must be free; it never stops or reuses an existing service.
