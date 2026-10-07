# Changelog

## 0.1.1

- Isolate extension provider registrations per API session so decorators such as jp-gate
  run once per model response, including when conversations are resumed or run concurrently.
- Add regression coverage for session creation, resumption, concurrency, disposal, and reopening.

## 0.1.0

- Initial release: OpenAI Responses API compatible server for Pi (responses, streaming, background,
  cancel, input items, input token counts, compaction, conversations, function/custom tools,
  structured outputs, reasoning items, images and files).
