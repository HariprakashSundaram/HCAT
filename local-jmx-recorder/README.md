# Local HTTP/S → JMX Recorder v0.7.0

A Chrome Manifest V3 extension that records HTTP/HTTPS requests from the selected browser tab and generates a local JMeter `.jmx`.

## What it does

- Captures browser network traffic through Chrome DevTools Protocol.
- Keeps captured data on the machine:
  - request/session data: IndexedDB inside the extension
  - settings: `chrome.storage.local`
- Creates named test steps.
- Lets each request be assigned to a step.
- Detects overlapping requests and emits BlazeMeter `bzm - Parallel Controller` groups.
- Exports a JMeter JMX file directly from the extension.
- Optionally captures response bodies.
- Masks common secret headers such as Authorization/Cookie by default.

## Important limitation

This extension uses `chrome.debugger` / Chrome DevTools Protocol rather than a proxy. It can observe HTTP/S network traffic for the attached tab, including request metadata, headers, and request bodies where Chrome exposes them. Response bodies are optional.

It does **not** bypass browser security, decrypt traffic from unrelated applications, or guarantee every browser-generated network payload. Some browser-internal traffic, extensions, downloads, WebSockets, service-worker behavior, multipart file contents, and very large bodies can require special handling.

When recording starts, Chrome treats the tab as being debugged. Do not use the recorder on pages where debugging access is not appropriate.

## Install

1. Unzip the package.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `local-jmx-recorder` folder.
6. Open the target web application.
7. Click the extension and choose **Start recording**.
8. Perform the user flow.
9. Stop recording.
10. Rename/add steps as needed.
11. Click **Auto-group parallel** and then **Export JMX**.

## Parallel Controller dependency

The generated JMX uses:

`com.blazemeter.jmeter.controller.ParallelSampler`

That is the BlazeMeter/JMeter Parallel Controller plugin component. A stock JMeter installation without that plugin will not be able to execute those controller nodes. Install the **Parallel Controller & Sampler** plugin through JMeter Plugins Manager before running a JMX that contains parallel groups.

If you want a stock-JMeter-only export in a future version, the exporter can instead emit a sequential plan or use another concurrency strategy.

## Local-only design

There is no `fetch()`/XHR to a remote service, no analytics SDK, no account/login, and no cloud upload endpoint in this extension. The extension uses only Chrome APIs and local browser storage.

## Security

This recorder can capture credentials, session cookies, tokens, and request bodies. Even though the extension is local-only, the recorded data is sensitive. Keep exported `.jmx` files private.

## Development

The extension is intentionally dependency-free: plain HTML/CSS/JavaScript and Chrome APIs.

Files:

- `manifest.json` — MV3 manifest
- `service_worker.js` — debugger/network capture and local IndexedDB persistence
- `popup.html` / `popup.css` / `popup.js` — recorder UI and JMX exporter

Test first with a non-sensitive web application and inspect the generated JMX before using it for load testing.

## Permission note

The extension requests Chrome's `debugger` permission because it uses Chrome DevTools Protocol to observe network traffic. Chrome may show a prominent debugging/inspection warning when recording is active. No cloud permission or remote endpoint is used.


## v0.2.0 export modes

The exporter now has two modes:

1. **Standard JMeter (no plugin)** — the safest default. It produces a JMX that does not reference `com.blazemeter.jmeter.controller.ParallelSampler`. It will open in a normal JMeter 5.6.x installation, but parallel browser requests are represented sequentially.
2. **BlazeMeter Parallel Controller** — preserves detected parallel groups using `com.blazemeter.jmeter.controller.ParallelSampler`. This mode requires the BlazeMeter Parallel Controller plugin.

If JMeter reports:

`CannotResolveClassException: com.blazemeter.jmeter.controller.ParallelSampler`

you exported BlazeMeter mode without the plugin installed. Either install the plugin or export **Standard JMeter** mode.


\n## v0.3.0 UI changes\n\n- JMX name, export mode, Export JMX, and Delete controls are now in the top toolbar.\n- The captured-request area is intentionally minimal: each row shows only the HTTP method and URL path/query.\n- Full URLs remain stored internally for JMX generation.\n

## v0.4.0 changes

- **Start** always resets the previous recording/session before beginning a new flow.
- **Pause / Resume** is available during recording. While paused, new network events are not captured.
- **Stop** automatically builds a domain list from the recorded traffic.
- Each domain has an include checkbox. Unchecked domains are excluded from both JMX and HAR exports.
- **Export JMX + HAR** downloads both files for the same filtered flow.
- The HAR is HAR 1.2 JSON and contains the recorded request/response metadata and optional response bodies.
- The popup is smaller and uses a compact layout with no horizontal scrolling.
- Clicking **＋ Step** creates a new recording step. Requests captured after that point are assigned to that step.
- Every step is exported as a built-in JMeter **TransactionController**, so the generated JMX structure is:

  `Thread Group → Transaction Controller (Step) → HTTP Request(s)`

- BlazeMeter export keeps detected overlapping requests inside its Parallel Controller. Standard export uses only built-in JMeter components.


\n## v0.5.0 changes\n\n- Fixed step assignment: the active step is stored locally and each network request is stamped with the step that was active when the request started. This prevents later steps from exporting empty Transaction Controllers.\n- Added automatic **content/resource type filters** for all types actually present in the recording, including HTML, JS, JSON, CSS, PNG, JPG, GIF, SVG, WebP, ICO, WOFF, WOFF2, TTF, OTF, WASM, PDF, XHR/fetch, WebSocket, media, manifest, and other MIME/resource types.\n- Domain and type filters both apply to JMX and HAR export.\n- Default test-plan filename is generated at Start as `recording_DDMMYYYY_HHMMSS.jmx`.\n

## v0.6.0 parallel JMX structure

The BlazeMeter export now follows the structure of the supplied reference JMX:

```text
Thread Group
└── Transaction Controller - Step N
    ├── HTTP Request
    ├── HTTP Request
    ├── bzm - Parallel Controller
    │   ├── HTTP Request
    │   ├── HTTP Request
    │   └── HTTP Request
    └── HTTP Request
```

The generated Parallel Controller uses:

```xml
<intProp name="MAX_THREAD_NUMBER">N</intProp>
<boolProp name="PARENT_SAMPLE">true</boolProp>
<boolProp name="LIMIT_MAX_THREAD_NUMBER">false</boolProp>
```

where `N` is the number of HTTP samplers in that parallel group.

Every HTTP sampler keeps its own `hashTree`, including its Header Manager, matching the structure of the supplied JMX example.

The parallel grouping is calculated independently inside each Transaction Controller after domain/type filtering, so excluded resources do not affect the grouping.



## v0.7.0 automatic parallel grouping

Parallel grouping is now **automatic**. The user no longer needs to press a Group button.

- The recorder detects request bursts independently inside each Step.
- Groups are calculated after domain/type exclusions.
- Groups are recalculated on Start, Stop, Step change, and Export.
- BlazeMeter Parallel is now the default JMX export mode.
- The generated controller is `bzm - Parallel Controller` with `PARENT_SAMPLE=true`, `LIMIT_MAX_THREAD_NUMBER=false`, and `MAX_THREAD_NUMBER` equal to the number of grouped HTTP samplers.
- Standard JMeter mode remains available, but it intentionally exports the requests sequentially because stock JMeter has no built-in equivalent to the BlazeMeter Parallel Controller.
- The grouping algorithm avoids blindly chaining unrelated requests just because one long-running request overlaps them.

