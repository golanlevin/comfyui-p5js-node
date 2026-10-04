import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { $el } from "/scripts/ui.js";

/*
 * Maintenance notes
 * -----------------
 * This frontend module does three jobs for the ComfyUI custom node:
 *
 * 1. Replace the raw script textarea with a CodeMirror editor and a Run Sketch
 *    button. ComfyUI widget values can lag behind DOM editor state, so sketch
 *    execution and prompt serialization read directly from the live CodeMirror
 *    document when available.
 * 2. Save the current sketch source into ComfyUI's temp/p5js area, load it in
 *    a sandboxed preview iframe, and ask that iframe to return a PNG Blob of
 *    its own canvas. Capturing inside the iframe avoids cross-document DOM
 *    quirks and keeps the parent node independent of p5.js internals.
 * 3. Provide a small p5 console pane and draggable splitters so students can
 *    see print()/console output and resize the editor, preview, and console.
 * 4. Keep the p5 sketch source serializable in exported workflow JSON. Avoid
 *    node-wide widget serialization suppression; mark only decorative/helper
 *    widgets as non-serializable so the script survives export/import.
 *    A node.onSerialize hook also injects the live CodeMirror source into
 *    workflow JSON because ComfyUI workflow export may read DOM widget .value
 *    fields directly instead of calling serializeValue().
 *
 * Important history:
 * - p5.js 2.x no longer behaved like the older global-mode injection this node
 *   originally relied on, so the preview iframe now wraps global-mode sketches
 *   into instance mode while still accepting explicit instance-mode sketches.
 * - RunComfy/ComfyUI serves uploaded .js files via /view with a MIME type that
 *   Chrome refuses to execute as a script. The iframe therefore fetches sketch
 *   source as text instead of inserting a <script src="..."> tag.
 * - p5.js can create a default 100x100 canvas before the user sketch runs.
 *   The iframe removes pre-existing canvases and waits for setup()/draw()
 *   readiness before capture, preventing accidental black default images.
 * - Date-suffixed filenames are used only when a RunComfy cache-bust is
 *   required. The intended stable extension filename is web/js/p5jsimage.js.
 */

const p5jsPreviewSrc = new URL(`../preview/index.html`, import.meta.url);
const P5JS_MESSAGE_SOURCE = "comfyui-p5js-node";
let canvasCaptureRequestId = 0;
const SPLITTER_HEIGHT = 4;
const PANE_MIN_HEIGHTS = {
  script: 120,
  preview: 160,
  console: 80,
};
const DEFAULT_PANE_HEIGHTS = {
  script: 240,
  preview: 400,
  console: 120,
};
const DEFAULT_SKETCH =
  "function setup() {\n  createCanvas(512, 512);\n}\n\nfunction draw() {\n  background(220);\n}";

/**
 * Upload a p5 sketch source file into ComfyUI's temporary p5js folder.
 *
 * ComfyUI's upload endpoint is image-oriented, but it accepts arbitrary files
 * and exposes them through /view, which is enough for the preview iframe to
 * fetch the sketch text.
 *
 * @param {string} filename Filename stem without the .js suffix.
 * @param {string} srcCode JavaScript source code from the editor.
 * @returns {Promise<Response>} The upload response from ComfyUI.
 */
async function saveSketch(filename, srcCode) {
  try {
    const blob = new Blob([srcCode], { type: "text/plain" });
    const file = new File([blob], filename + ".js");
    const body = new FormData();
    body.append("image", file);
    body.append("subfolder", "p5js");
    body.append("type", "temp");
    body.append("overwrite", "true");
    const resp = await api.fetchApi("/upload/image", {
      method: "POST",
      body,
    });
    if (resp.status !== 200) {
      const err = `Error uploading sketch: ${resp.status} - ${resp.statusText}`;
      alert(err);
      throw new Error(err);
    }

    return resp;
  } catch (e) {
    console.error("Error sending sketch file for saving:", e);
    throw e;
  }
}

/**
 * Find the p5 canvas in a document.
 *
 * @param {Document | null | undefined} doc iframe document to inspect.
 * @returns {HTMLCanvasElement | null} The default p5 canvas or first canvas.
 */
function findP5Canvas(doc) {
  return doc?.getElementById("defaultCanvas0") || doc?.querySelector("canvas");
}

/**
 * Ask the preview iframe to capture its canvas as a PNG Blob.
 *
 * The iframe owns the canvas and can safely call toBlob() on it. The parent
 * retries the capture request while the iframe is navigating so a Run Sketch
 * click does not race the iframe load event.
 *
 * @param {HTMLIFrameElement} iframe Preview iframe DOM element.
 * @param {number} [timeoutMs=15000] Maximum time to wait for a response.
 * @returns {Promise<Blob>} PNG image data captured by the iframe.
 */
function captureCanvasFromIframe(iframe, timeoutMs = 15000) {
  const requestId = ++canvasCaptureRequestId;

  return new Promise((resolve, reject) => {
    const frameWindow = iframe.contentWindow;
    if (!frameWindow) {
      reject(new Error("p5.js preview iframe is not available"));
      return;
    }

    const request = {
      source: P5JS_MESSAGE_SOURCE,
      type: "captureCanvas",
      requestId,
      timeoutMs,
    };

    const sendRequest = () => {
      frameWindow.postMessage(request, window.location.origin);
    };

    const retry = setInterval(sendRequest, 250);
    const timer = setTimeout(() => {
      clearInterval(retry);
      window.removeEventListener("message", onMessage);
      reject(new Error("Timed out waiting for p5.js canvas capture"));
    }, timeoutMs + 1000);

    /**
     * Resolve the pending capture promise when the matching iframe response
     * arrives.
     *
     * @param {MessageEvent} event postMessage event from the preview iframe.
     */
    function onMessage(event) {
      const data = event.data || {};
      if (
        event.source !== frameWindow ||
        data.source !== P5JS_MESSAGE_SOURCE ||
        data.type !== "canvasCapture" ||
        data.requestId !== requestId
      ) {
        return;
      }

      clearTimeout(timer);
      clearInterval(retry);
      window.removeEventListener("message", onMessage);

      if (!data.ok) {
        reject(new Error(data.error || "p5.js sketch did not produce a canvas"));
        return;
      }
      if (!data.blob) {
        reject(new Error("p5.js canvas capture returned no image data"));
        return;
      }

      resolve(data.blob);
    }

    window.addEventListener("message", onMessage);
    sendRequest();
  });
}

/**
 * Build the node-local console pane used for p5 print()/console output.
 *
 * @returns {HTMLDivElement & {_output?: HTMLDivElement}} Console pane element.
 */
function createConsolePane() {
  const pane = $el("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      width: "100%",
      height: "100%",
      minHeight: "100px",
      boxSizing: "border-box",
      border: "1px solid #111",
      background: "#151719",
      color: "#d8dee9",
      font:
        "11px/1.35 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      overflow: "hidden",
    },
  });

  const toolbar = $el("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "4px 6px",
      borderBottom: "1px solid #272b30",
      background: "#1d2024",
      color: "#9ca3af",
      flex: "0 0 auto",
    },
  });

  const label = $el("span", {
    textContent: "p5 console",
    style: {
      fontSize: "11px",
      fontWeight: "600",
      textTransform: "uppercase",
      letterSpacing: "0",
    },
  });

  const clearButton = $el("button", {
    textContent: "Clear",
    style: {
      border: "1px solid #383d45",
      borderRadius: "3px",
      background: "#242830",
      color: "#d8dee9",
      font: "inherit",
      padding: "1px 6px",
      cursor: "pointer",
    },
  });

  const output = $el("div", {
    style: {
      flex: "1 1 auto",
      minHeight: "0",
      overflow: "auto",
      padding: "6px",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
    },
  });

  clearButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    clearConsolePane(pane);
  });

  for (const evt of ["pointerdown", "mousedown", "dblclick", "wheel"]) {
    pane.addEventListener(evt, (event) => event.stopPropagation());
  }

  toolbar.append(label, clearButton);
  pane.append(toolbar, output);
  pane._output = output;
  return pane;
}

/**
 * Remove all visible output lines from the p5 console pane.
 *
 * @param {{_output?: HTMLElement} | null | undefined} pane Console pane.
 */
function clearConsolePane(pane) {
  if (pane?._output) {
    pane._output.textContent = "";
  }
}

/**
 * Append one formatted line to the p5 console pane.
 *
 * @param {{_output?: HTMLElement} | null | undefined} pane Console pane.
 * @param {string} level Console level such as log, info, warn, or error.
 * @param {string} message Already-formatted message text.
 */
function appendConsoleMessage(pane, level, message) {
  if (!pane?._output) return;

  const line = document.createElement("div");
  const colors = {
    debug: "#8b949e",
    info: "#79c0ff",
    log: "#d8dee9",
    warn: "#f2cc60",
    error: "#ff7b72",
  };

  line.style.color = colors[level] || colors.log;
  line.textContent = `[${level || "log"}] ${message || ""}`;
  pane._output.appendChild(line);

  while (pane._output.childNodes.length > 250) {
    pane._output.removeChild(pane._output.firstChild);
  }

  pane._output.scrollTop = pane._output.scrollHeight;
}

/**
 * Forward console messages posted by the iframe into the node console pane.
 *
 * @param {HTMLIFrameElement} iframe Preview iframe to listen to.
 * @param {HTMLElement & {_output?: HTMLElement}} pane Console pane element.
 * @returns {() => void} Detach callback for the message listener.
 */
function attachPreviewConsole(iframe, pane) {
  /**
   * Receive console bridge messages from the matching iframe only.
   *
   * @param {MessageEvent} event postMessage event from any frame.
   */
  function onMessage(event) {
    const data = event.data || {};
    if (
      event.source !== iframe.contentWindow ||
      data.source !== P5JS_MESSAGE_SOURCE ||
      data.type !== "console"
    ) {
      return;
    }

    appendConsoleMessage(pane, data.level, data.message);
  }

  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

/**
 * Get mutable editor/preview/console pane heights for a node.
 *
 * @param {import("/scripts/app.js").LGraphNode} node ComfyUI graph node.
 * @returns {{script: number, preview: number, console: number}} Pane heights.
 */
function getPaneHeights(node) {
  if (!node._p5jsPaneHeights) {
    const savedHeights = node.properties?.p5jsPaneHeights || {};
    node._p5jsPaneHeights = {
      ...DEFAULT_PANE_HEIGHTS,
      ...savedHeights,
    };
  }
  return node._p5jsPaneHeights;
}

/**
 * Restore saved pane heights from node properties into the live widget state.
 *
 * @param {import("/scripts/app.js").LGraphNode} node ComfyUI graph node.
 * @returns {boolean} True when saved pane heights were applied.
 */
function restorePaneHeights(node) {
  const savedHeights = node.properties?.p5jsPaneHeights;
  if (!savedHeights || typeof savedHeights !== "object") return false;

  const heights = getPaneHeights(node);
  for (const pane of Object.keys(DEFAULT_PANE_HEIGHTS)) {
    const value = Number(savedHeights[pane]);
    if (Number.isFinite(value)) {
      heights[pane] = Math.max(PANE_MIN_HEIGHTS[pane], value);
    }
  }
  savePaneHeights(node);
  refreshNodeLayout(node);
  return true;
}

/**
 * Persist pane heights onto node.properties so workflows can remember them.
 *
 * @param {import("/scripts/app.js").LGraphNode} node ComfyUI graph node.
 */
function savePaneHeights(node) {
  node.properties ||= {};
  node.properties.p5jsPaneHeights = { ...getPaneHeights(node) };
}

/**
 * Store the current sketch source in node.properties as an export/import backup.
 *
 * @param {import("/scripts/app.js").LGraphNode} node ComfyUI graph node.
 * @param {string} script Current p5 sketch source.
 */
function saveScriptProperty(node, script) {
  node.properties ||= {};
  node.properties.p5jsScript = script;
}

/**
 * Read the best available saved script from node properties.
 *
 * @param {import("/scripts/app.js").LGraphNode} node ComfyUI graph node.
 * @returns {string | undefined} Saved script source, if any.
 */
function getSavedScriptProperty(node) {
  return typeof node.properties?.p5jsScript === "string"
    ? node.properties.p5jsScript
    : undefined;
}

/**
 * Read sketch source from any workflow-load location ComfyUI may expose.
 *
 * @param {import("/scripts/app.js").LGraphNode} node ComfyUI graph node.
 * @returns {string | undefined} Serialized script source, if found.
 */
function getSerializedScript(node) {
  const propertyScript = getSavedScriptProperty(node);
  if (propertyScript) return propertyScript;

  const scriptWidget = getScriptWidget(node);
  if (typeof scriptWidget?.value === "string" && scriptWidget.value) {
    return scriptWidget.value;
  }

  if (typeof node.widgets_values_named?.script === "string") {
    return node.widgets_values_named.script;
  }

  const scriptIndex = getWidgetIndex(node, "script");
  const indexedValue = node.widgets_values?.[scriptIndex];
  return typeof indexedValue === "string" && indexedValue ? indexedValue : undefined;
}

/**
 * Ask ComfyUI to recompute DOM widget layout after pane height changes.
 *
 * @param {import("/scripts/app.js").LGraphNode} node ComfyUI graph node.
 */
function refreshNodeLayout(node) {
  if (node.setSize && node.size) {
    node.setSize([node.size[0], node.size[1]]);
  }
  app.graph?.setDirtyCanvas?.(true, true);
}

/**
 * Create a thin draggable horizontal splitter between two pane widgets.
 *
 * Dragging moves height from one neighboring pane to the other, which keeps the
 * node's total height stable and avoids fighting ComfyUI's DOM-widget layout.
 *
 * @param {import("/scripts/app.js").LGraphNode} node ComfyUI graph node.
 * @param {"script" | "preview" | "console"} upperPane Pane above the splitter.
 * @param {"script" | "preview" | "console"} lowerPane Pane below the splitter.
 * @returns {HTMLDivElement} Splitter element.
 */
function createPaneSplitter(node, upperPane, lowerPane) {
  const splitter = $el("div", {
    title: "Drag to resize panes",
    style: {
      height: `${SPLITTER_HEIGHT}px`,
      minHeight: `${SPLITTER_HEIGHT}px`,
      maxHeight: `${SPLITTER_HEIGHT}px`,
      width: "100%",
      boxSizing: "border-box",
      cursor: "row-resize",
      background: "#2d2f33",
      borderTop: "1px solid #17191c",
      borderBottom: "1px solid #17191c",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    },
  });
  splitter.style.setProperty(
    "--comfy-widget-min-height",
    `${SPLITTER_HEIGHT}px`,
  );
  splitter.style.setProperty(
    "--comfy-widget-height",
    `${SPLITTER_HEIGHT}px`,
  );

  const grip = $el("div", {
    style: {
      width: "48px",
      height: "2px",
      borderRadius: "2px",
      background: "#6b7280",
      opacity: "0.75",
      pointerEvents: "none",
    },
  });

  splitter.append(grip);

  splitter.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();

    const heights = getPaneHeights(node);
    const startY = event.clientY;
    const startUpper = heights[upperPane];
    const startLower = heights[lowerPane];
    const total = startUpper + startLower;

    splitter.setPointerCapture?.(event.pointerId);

    /**
     * Resize the neighboring panes while the pointer is dragging the splitter.
     *
     * @param {PointerEvent} moveEvent Active pointer move event.
     */
    function onPointerMove(moveEvent) {
      moveEvent.preventDefault();
      moveEvent.stopPropagation();

      const dy = moveEvent.clientY - startY;
      const minUpper = PANE_MIN_HEIGHTS[upperPane];
      const minLower = PANE_MIN_HEIGHTS[lowerPane];
      const nextUpper = Math.max(
        minUpper,
        Math.min(total - minLower, startUpper + dy),
      );
      heights[upperPane] = nextUpper;
      heights[lowerPane] = total - nextUpper;
      savePaneHeights(node);
      refreshNodeLayout(node);
    }

    /**
     * End a splitter drag and detach document-level pointer handlers.
     *
     * @param {PointerEvent} upEvent Pointer release event.
     */
    function onPointerUp(upEvent) {
      upEvent.preventDefault();
      upEvent.stopPropagation();
      splitter.releasePointerCapture?.(event.pointerId);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      refreshNodeLayout(node);
    }

    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
  });

  for (const evt of ["pointerdown", "mousedown", "dblclick", "wheel"]) {
    splitter.addEventListener(evt, (event) => event.stopPropagation());
  }

  return splitter;
}

/**
 * Add a splitter as a ComfyUI DOM widget.
 *
 * @param {import("/scripts/app.js").LGraphNode} node ComfyUI graph node.
 * @param {string} name Widget name.
 * @param {"script" | "preview" | "console"} upperPane Pane above splitter.
 * @param {"script" | "preview" | "console"} lowerPane Pane below splitter.
 * @returns {object} ComfyUI DOM widget object.
 */
function addPaneSplitterWidget(node, name, upperPane, lowerPane) {
  const splitter = createPaneSplitter(node, upperPane, lowerPane);
  const widget = node.addDOMWidget(name, "P5JS Splitter", splitter, {
    hideOnZoom: false,
    getMinHeight: () => SPLITTER_HEIGHT,
    getMaxHeight: () => SPLITTER_HEIGHT,
    getHeight: () => SPLITTER_HEIGHT,
  });
  widget.serialize = false;
  widget.serializeValue = () => undefined;
  return widget;
}

/**
 * Poll the iframe document until p5.js has created a canvas.
 *
 * This is retained for older direct-canvas code paths and local debugging; the
 * production capture path uses captureCanvasFromIframe().
 *
 * @param {HTMLIFrameElement} iframe Preview iframe.
 * @param {number} [timeoutMs=15000] Maximum wait time.
 * @returns {Promise<HTMLCanvasElement | null>} Canvas or null on timeout.
 */
async function waitForCanvas(iframe, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    const canvas = findP5Canvas(doc);
    if (canvas && canvas.width > 0 && canvas.height > 0) {
      // Give draw() a moment to render its first frame before we read pixels.
      await new Promise((r) => setTimeout(r, 200));
      return canvas;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

/**
 * Determine the intended export size for a canvas.
 *
 * @param {HTMLCanvasElement} canvas Canvas to export.
 * @returns {{width: number, height: number}} Pixel dimensions.
 */
function getCanvasExportSize(canvas) {
  const width = Math.round(canvas.clientWidth || canvas.width);
  const height = Math.round(canvas.clientHeight || canvas.height);
  return {
    width: Math.max(1, width),
    height: Math.max(1, height),
  };
}

/**
 * Convert a canvas element to a PNG Blob.
 *
 * @param {HTMLCanvasElement} canvas Canvas to encode.
 * @returns {Promise<Blob | null>} PNG Blob, or null if the browser fails.
 */
function canvasToPngBlob(canvas) {
  const { width, height } = getCanvasExportSize(canvas);
  let exportCanvas = canvas;

  if (canvas.width !== width || canvas.height !== height) {
    exportCanvas = document.createElement("canvas");
    exportCanvas.width = width;
    exportCanvas.height = height;
    const ctx = exportCanvas.getContext("2d");
    ctx.drawImage(canvas, 0, 0, width, height);
  }

  return new Promise((r) => exportCanvas.toBlob(r, "image/png"));
}

/**
 * Save the current script and navigate the preview iframe to that sketch.
 *
 * Waiting for the iframe load event prevents captures from hitting the previous
 * document immediately after iframe.src changes.
 *
 * @param {HTMLIFrameElement} iframe Preview iframe.
 * @param {string} sketchfile Filename stem for the temp sketch.
 * @param {string} srcCode JavaScript sketch source.
 * @returns {Promise<void>} Resolves after the iframe has loaded.
 */
async function loadSketch(iframe, sketchfile, srcCode) {
  await saveSketch(sketchfile, srcCode);
  const nextSrc =
    p5jsPreviewSrc +
    "?sketch=" +
    encodeURIComponent(sketchfile + ".js") +
    "&reload=" +
    Date.now();

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      iframe.removeEventListener("load", onLoad);
      reject(new Error("Timed out loading p5.js preview iframe"));
    }, 10000);

    /**
     * Resolve once the iframe finishes navigating to the newly uploaded sketch.
     */
    function onLoad() {
      clearTimeout(timer);
      resolve();
    }

    iframe.addEventListener("load", onLoad, { once: true });
    iframe.src = nextSrc;
  });
}

/**
 * Save, load, and wait for a canvas in the preview iframe.
 *
 * @param {HTMLIFrameElement} iframe Preview iframe.
 * @param {string} sketchfile Filename stem for the temp sketch.
 * @param {string} srcCode JavaScript sketch source.
 * @returns {Promise<HTMLCanvasElement | null>} Canvas found by polling.
 */
async function runSketch(iframe, sketchfile, srcCode) {
  await loadSketch(iframe, sketchfile, srcCode);
  return waitForCanvas(iframe);
}

let codeMirrorPromise = null;

/**
 * Lazy-load CodeMirror 6 and JavaScript editing support.
 *
 * The editor is pulled from esm.sh so this custom node does not need a package
 * build step. The promise is shared across all node instances.
 *
 * @returns {Promise<object>} CodeMirror modules used by mountCodeMirror().
 */
function loadCodeMirror() {
  if (!codeMirrorPromise) {
    codeMirrorPromise = Promise.all([
      import("https://esm.sh/codemirror@6.0.1"),
      import("https://esm.sh/@codemirror/lang-javascript@6.2.2"),
      import("https://esm.sh/@codemirror/theme-one-dark@6.1.2"),
      import("https://esm.sh/@codemirror/view@6.26.3"),
      import("https://esm.sh/@codemirror/commands@6.5.0"),
    ]).then(([cm, langJs, theme, view, commands]) => ({
      EditorView: cm.EditorView,
      basicSetup: cm.basicSetup,
      javascript: langJs.javascript,
      oneDark: theme.oneDark,
      keymap: view.keymap,
      indentWithTab: commands.indentWithTab,
      indentMore: commands.indentMore,
      indentLess: commands.indentLess,
    }));
  }
  return codeMirrorPromise;
}

/**
 * Extract the default value from a ComfyUI custom-widget input spec.
 *
 * @param {Array | object | undefined} inputData ComfyUI input metadata.
 * @param {string} [fallback=""] Fallback when no default is present.
 * @returns {string} Default script text.
 */
function getInputDefault(inputData, fallback = "") {
  return inputData?.[1]?.default ?? inputData?.default ?? fallback;
}

/**
 * Return the index of a named widget in node.widgets.
 *
 * @param {import("/scripts/app.js").LGraphNode} node ComfyUI graph node.
 * @param {string} name Widget name to find.
 * @returns {number} Widget index, or -1 when absent.
 */
function getWidgetIndex(node, name) {
  return node.widgets?.findIndex((w) => w.name === name) ?? -1;
}

/**
 * Replace the entire contents of a CodeMirror editor.
 *
 * @param {object} editor CodeMirror EditorView.
 * @param {string} value New document text.
 */
function setCodeMirrorDocument(editor, value) {
  editor.dispatch({
    changes: {
      from: 0,
      to: editor.state.doc.length,
      insert: value,
    },
  });
}

/**
 * Push script source into the widget, CodeMirror editor, and backup property.
 *
 * @param {import("/scripts/app.js").LGraphNode} node ComfyUI graph node.
 * @param {string} script Sketch source to install.
 */
function setScriptValue(node, script) {
  const widget = getScriptWidget(node);
  if (!widget || typeof script !== "string") return;

  widget.value = script;
  widget._p5jsPendingValue = script;
  saveScriptProperty(node, script);

  if (widget._cmEditor && widget._cmEditor.state.doc.toString() !== script) {
    setCodeMirrorDocument(widget._cmEditor, script);
  }
}

/**
 * Find the script editor widget on a node.
 *
 * @param {import("/scripts/app.js").LGraphNode} node ComfyUI graph node.
 * @returns {object | undefined} Script widget.
 */
function getScriptWidget(node) {
  return node.widgets.find((w) => w.name === "script");
}

/**
 * Read the current sketch source from the live editor.
 *
 * The critical detail is the _p5jsGetValue/_cmEditor path: reading widget.value
 * alone can return stale or empty text in modern ComfyUI DOM widgets.
 *
 * @param {import("/scripts/app.js").LGraphNode} node ComfyUI graph node.
 * @returns {string} Current p5 sketch source.
 */
function getScriptValue(node) {
  const widget = getScriptWidget(node);
  let script = DEFAULT_SKETCH;
  if (widget?._p5jsGetValue) {
    script = widget._p5jsGetValue();
  } else if (widget?._cmEditor) {
    script = widget._cmEditor.state.doc.toString();
  } else if (widget?.value != null) {
    script = widget.value;
  }
  saveScriptProperty(node, script);
  return script;
}

/**
 * Install a final workflow-serialization hook for this node.
 *
 * Prompt execution uses widget.serializeValue(), but workflow export may simply
 * copy widget.value into widgets_values. This hook runs during node serialization
 * and force-writes the live CodeMirror text into widgets_values,
 * widgets_values_named, and node.properties.
 *
 * @param {import("/scripts/app.js").LGraphNode} node ComfyUI graph node.
 */
function installWorkflowSerialization(node) {
  if (node._p5jsWorkflowSerializationInstalled) return;

  const previousOnSerialize = node.onSerialize?.bind(node);
  node.onSerialize = function (serialized) {
    previousOnSerialize?.(serialized);

    const script = getScriptValue(node);
    const paneHeights = { ...getPaneHeights(node) };
    saveScriptProperty(node, script);
    savePaneHeights(node);

    serialized.properties ||= {};
    serialized.properties.p5jsScript = script;
    serialized.properties.p5jsPaneHeights = paneHeights;

    serialized.widgets_values_named ||= {};
    serialized.widgets_values_named.script = script;

    const scriptIndex = getWidgetIndex(node, "script");
    if (scriptIndex >= 0) {
      serialized.widgets_values ||= [];
      serialized.widgets_values[scriptIndex] = script;
    }
  };

  node._p5jsWorkflowSerializationInstalled = true;
}

/**
 * Restore saved sketch text after a workflow is loaded.
 *
 * ComfyUI can apply workflow widget values after custom DOM widgets are
 * constructed. CodeMirror does not automatically notice later widget.value
 * changes, so this retry loop re-pushes serialized source into the editor once
 * both the node properties and editor widget are available.
 *
 * @param {import("/scripts/app.js").LGraphNode} node ComfyUI graph node.
 */
function restoreScriptAfterWorkflowLoad(node) {
  let attempts = 0;

  function attemptRestore() {
    restorePaneHeights(node);

    const script = getSerializedScript(node);
    if (script) {
      setScriptValue(node, script);
    }

    attempts += 1;
    const widget = getScriptWidget(node);
    if ((!widget?._cmEditor || !script) && attempts < 120) {
      requestAnimationFrame(attemptRestore);
    }
  }

  requestAnimationFrame(attemptRestore);
}

/**
 * Mount CodeMirror into a prepared container and bind it to a widget.
 *
 * @param {object} widget ComfyUI widget object used for serialization.
 * @param {HTMLElement} container Empty DOM element for the editor.
 * @param {string} initialValue Initial sketch source.
 * @returns {Promise<void>} Resolves after CodeMirror is mounted.
 */
async function mountCodeMirror(widget, container, initialValue) {
  const {
    EditorView,
    basicSetup,
    javascript,
    oneDark,
    keymap,
    indentWithTab,
    indentMore,
    indentLess,
  } = await loadCodeMirror();
  console.log("[p5js] CodeMirror loaded");

  widget.value = initialValue ?? "";

  const editor = new EditorView({
    doc: widget.value,
    extensions: [
      basicSetup,
      keymap.of([indentWithTab]),
      javascript(),
      oneDark,
      EditorView.theme({
        "&": { height: "100%", fontSize: "12px" },
        ".cm-scroller": {
          overflow: "auto",
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        },
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          // Push the new text back into the widget, which keeps ComfyUI's
          // prompt serialization in sync.
          widget.value = editor.state.doc.toString();
          if (widget._p5jsNode) {
            saveScriptProperty(widget._p5jsNode, widget.value);
          }
        }
      }),
    ],
    parent: container,
  });

  // Capture-phase handler — runs before any ComfyUI listener can move focus
  // off the editor. Manually invoke indentMore / indentLess instead of relying
  // on CodeMirror's keymap, which can lose the race against outer listeners.
  container.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Tab") return;
      e.preventDefault();
      e.stopPropagation();
      (e.shiftKey ? indentLess : indentMore)(editor);
    },
    true,
  );

  // Clicks inside the editor should place the text caret — not start a node
  // drag. Let CodeMirror handle the event, then stop it bubbling out to
  // ComfyUI's canvas.
  for (const evt of ["pointerdown", "mousedown", "dblclick"]) {
    container.addEventListener(evt, (e) => e.stopPropagation());
  }

  widget._cmEditor = editor;
  widget._p5jsGetValue = () => editor.state.doc.toString();
  widget.serializeValue = widget._p5jsGetValue;
  if (typeof widget._p5jsPendingValue === "string") {
    setCodeMirrorDocument(editor, widget._p5jsPendingValue);
  }
  if (widget._p5jsNode) {
    saveScriptProperty(widget._p5jsNode, widget._p5jsGetValue());
  }
}

/**
 * Upgrade an older native textarea script widget to CodeMirror.
 *
 * New workflows use the P5JS_SCRIPT custom widget directly; this fallback keeps
 * older saved workflows editable.
 *
 * @param {object} widget Existing ComfyUI script widget.
 * @returns {Promise<void>} Resolves after the upgrade attempt.
 */
async function attachCodeMirror(widget) {
  console.log("[p5js] script widget:", widget);
  console.log("[p5js] widget keys:", Object.keys(widget));
  console.log(
    "[p5js] element:",
    widget.element,
    "inputEl:",
    widget.inputEl,
    "options:",
    widget.options,
  );

  // The widget's element gets mounted into ComfyUI's DOM container a few frames
  // after the widget is created. Wait until it actually has a parent, AND also
  // fall back to a DOM query for the textarea that ComfyUI eventually attaches.
  let target = null;
  for (let i = 0; i < 240; i++) {
    target =
      (widget.element && widget.element.parentNode && widget.element) ||
      (widget.inputEl && widget.inputEl.parentNode && widget.inputEl) ||
      (widget.element instanceof HTMLElement ? widget.element : null) ||
      null;
    if (target && target.parentNode) break;

    // Last-resort: scan the DOM for the textarea ComfyUI creates for the
    // multiline string widget on this node.
    const allTextareas = document.querySelectorAll(
      "textarea.comfy-multiline-input, textarea",
    );
    for (const ta of allTextareas) {
      if (
        ta.value === widget.value ||
        ta.placeholder === widget.name ||
        ta.dataset?.widgetName === widget.name
      ) {
        target = ta;
        break;
      }
    }
    if (target && target.parentNode) break;
    target = null;

    await new Promise((r) => requestAnimationFrame(r));
  }
  if (!target || !target.parentNode) {
    console.warn(
      "[p5js] script widget element never mounted; skipping CodeMirror",
      widget,
    );
    return;
  }
  console.log("[p5js] mounting CodeMirror onto", target.tagName, target);

  const initialValue = widget.value ?? target.value ?? "";

  const container = document.createElement("div");
  container.style.cssText =
    "width: 100%; height: 100%; min-height: 200px; overflow: hidden;" +
    "box-sizing: border-box; border-radius: 4px; cursor: text;";

  target.parentNode.replaceChild(container, target);
  await mountCodeMirror(widget, container, initialValue);
}

// Kick off the CDN fetch early so the editor is ready by the time a node is created.
loadCodeMirror();

app.registerExtension({
  name: "HYPE_P5JSImage",

  /**
   * Register custom DOM widgets used by the Python node's INPUT_TYPES.
   *
   * P5JS_SCRIPT replaces the multiline source editor. P5JS hosts the iframe
   * preview, wires up Run Sketch, and adds the console pane.
   *
   * @returns {object} Custom widget factory map for ComfyUI.
   */
  getCustomWidgets(app) {
    return {
      /**
       * Create the CodeMirror-backed sketch editor widget.
       *
       * @param {import("/scripts/app.js").LGraphNode} node Owning node.
       * @param {string} inputName Widget/input name from INPUT_TYPES.
       * @param {Array | object | undefined} inputData ComfyUI input metadata.
       * @returns {object} ComfyUI DOM widget.
       */
      P5JS_SCRIPT(node, inputName, inputData) {
        getPaneHeights(node);
        const initialValue =
          getSavedScriptProperty(node) ||
          getInputDefault(inputData, DEFAULT_SKETCH);
        const container = $el("div", {
          style: {
            display: "flex",
            flexDirection: "column",
            width: "100%",
            height: "100%",
            minHeight: "220px",
            overflow: "hidden",
            boxSizing: "border-box",
            borderRadius: "4px",
            cursor: "text",
          },
        });
        const toolbar = $el("div", {
          style: {
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
            flex: "0 0 auto",
            padding: "4px 6px",
            borderBottom: "1px solid #272b30",
            background: "#1d2024",
            color: "#9ca3af",
            boxSizing: "border-box",
            cursor: "default",
          },
        });
        const label = $el("span", {
          textContent: "p5 sketch",
          style: {
            fontSize: "11px",
            fontWeight: "600",
            textTransform: "uppercase",
            letterSpacing: "0",
          },
        });
        const runButton = $el("button", {
          textContent: "> Run Sketch",
          style: {
            border: "1px solid #383d45",
            borderRadius: "3px",
            background: "#242830",
            color: "#d8dee9",
            font:
              "11px/1.35 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            padding: "2px 8px",
            cursor: "pointer",
          },
        });
        const editorHost = $el("div", {
          style: {
            flex: "1 1 auto",
            minHeight: "0",
            overflow: "hidden",
          },
        });

        // The toolbar button intentionally calls the same node method used by
        // other code paths so Run Sketch and Queue Prompt stay in sync.
        runButton.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (node._p5jsRunSketch) {
            node._p5jsRunSketch();
          } else {
            alert("p5.js preview is not ready yet");
          }
        });

        for (const evt of ["pointerdown", "mousedown", "dblclick"]) {
          toolbar.addEventListener(evt, (event) => event.stopPropagation());
        }

        toolbar.append(label, runButton);
        container.append(toolbar, editorHost);

        const widget = node.addDOMWidget(
          inputName,
          "P5JS_SCRIPT",
          container,
          {
            hideOnZoom: false,
            getMinHeight: () => getPaneHeights(node).script,
          },
        );
        widget.value = initialValue;
        widget._p5jsNode = node;
        widget.serialize = true;
        widget._p5jsCustomScript = true;
        widget._p5jsGetValue = () => widget.value ?? "";
        widget.serializeValue = () => getScriptValue(node);

        // Splitter widgets live between the pane widgets. ComfyUI stacks DOM
        // widgets in creation order, so this separator follows the editor.
        addPaneSplitterWidget(
          node,
          "p5js_script_preview_splitter",
          "script",
          "preview",
        );

        (async () => {
          for (let i = 0; i < 5; i++) {
            await new Promise((r) => requestAnimationFrame(r));
          }
          await mountCodeMirror(widget, editorHost, widget.value ?? initialValue);
        })().catch((e) => {
          console.error("Failed to mount CodeMirror editor:", e);
        });

        return widget;
      },

      /**
       * Create the p5 preview iframe and console widgets.
       *
       * @param {import("/scripts/app.js").LGraphNode} node Owning node.
       * @param {string} inputName Widget/input name from INPUT_TYPES.
       * @returns {object} ComfyUI DOM widget for the preview iframe.
       */
      P5JS(node, inputName) {
        getPaneHeights(node);
        const d = new Date();
        const base_filename =
          d.getUTCFullYear() +
          "_" +
          (d.getUTCMonth() + 1) +
          "_" +
          d.getUTCDate() +
          "_";

        const sketchfile =
          base_filename + Math.floor(Math.random() * 10000);

        const iframe = $el("iframe", {
          src: p5jsPreviewSrc,
          style: {
            border: "1px solid #000",
            width: "100%",
            height: "100%",
            padding: 0,
            margin: 0,
            display: "block",
            background: "#222",
          },
        });
        const consolePane = createConsolePane();
        const detachConsole = attachPreviewConsole(iframe, consolePane);

        // Run Sketch saves the current editor text, reloads the preview iframe,
        // and asks the iframe to capture the rendered canvas. It deliberately
        // does not upload the PNG to ComfyUI; that happens during serialization
        // when the workflow actually queues.
        node._p5jsRunSketch = () => {
          clearConsolePane(consolePane);
          const srcCode = getScriptValue(node);
          appendConsoleMessage(
            consolePane,
            "info",
            `Uploading p5 sketch: ${srcCode.length} chars`,
          );
          return loadSketch(iframe, sketchfile, srcCode)
            .then(() => captureCanvasFromIframe(iframe))
            .catch((e) => {
              const err = `Error running p5.js sketch: ${e.message || e}`;
              alert(err);
              console.error(err, e);
              throw e;
            });
        };

        // addDOMWidget mounts the iframe inside ComfyUI's DOM-widget container,
        // which is automatically positioned/scaled by ComfyUI as the canvas pans and zooms.
        const widget = node.addDOMWidget("image", "P5JS", iframe, {
          hideOnZoom: false,
          getMinHeight: () => getPaneHeights(node).preview,
        });
        widget.sketchfile = sketchfile;
        widget.consolePane = consolePane;
        widget.detachConsole = detachConsole;
        widget.value = "";

        // This separator follows the preview and resizes preview/console.
        addPaneSplitterWidget(
          node,
          "p5js_preview_console_splitter",
          "preview",
          "console",
        );

        const consoleWidget = node.addDOMWidget(
          "p5js_console",
          "P5JS Console",
          consolePane,
          {
            hideOnZoom: false,
            getMinHeight: () => getPaneHeights(node).console,
          },
        );
        consoleWidget.serialize = false;
        consoleWidget.serializeValue = () => undefined;

        return widget;
      },
    };
  },

  /**
   * Finalize each HYPE_P5JSImage node after ComfyUI creates its widgets.
   *
   * This hook supplies backward compatibility for old workflows and overrides
   * the P5JS widget's serialization so Queue Prompt uploads a PNG file path
   * that the Python node can load as an IMAGE.
   *
   * @param {import("/scripts/app.js").LGraphNode} node Newly created node.
   */
  nodeCreated(node) {
    if (node.constructor.comfyClass !== "HYPE_P5JSImage") return;

    // Workflow export relies on widget serialization to save the script text.
    // Some debugging builds set this false at the node level, which caused
    // exported workflows to lose the p5 code. Keep node-wide serialization on
    // and opt individual helper widgets out with widget.serialize = false.
    node.serialize_widgets = true;
    installWorkflowSerialization(node);
    restoreScriptAfterWorkflowLoad(node);

    // Older saved workflows may still have a native STRING widget for script.
    // New nodes use the custom P5JS_SCRIPT widget above.
    const scriptWidget = node.widgets.find((w) => w.name === "script");
    if (scriptWidget && !scriptWidget._p5jsCustomScript && !scriptWidget._cmEditor) {
      attachCodeMirror(scriptWidget).catch((e) => {
        console.error("Failed to mount CodeMirror editor:", e);
      });
    }

    const p5jsWidget = node.widgets.find((w) => w.name === "image");

    // serializeValue is called by ComfyUI while graphToPrompt is building the
    // prompt. Returning "p5js/name.png [temp]" matches ComfyUI's annotated file
    // path convention and lets the Python side call LoadImage safely.
    p5jsWidget.serializeValue = async () => {
      // Always reload the sketch before capture so queued workflows use the
      // current editor contents, not a previously-rendered canvas.
      const theFrame = p5jsWidget.element;
      clearConsolePane(p5jsWidget.consolePane);
      const srcCode = getScriptValue(node);
      appendConsoleMessage(
        p5jsWidget.consolePane,
        "info",
        `Uploading p5 sketch: ${srcCode.length} chars`,
      );
      await loadSketch(theFrame, p5jsWidget.sketchfile, srcCode);
      const blob = await captureCanvasFromIframe(theFrame);

      if (!blob) {
        const err = "Could not capture p5.js canvas";
        alert(err);
        throw new Error(err);
      }

      const name = `${+new Date()}.png`;
      const file = new File([blob], name);
      const body = new FormData();
      body.append("image", file);
      body.append("subfolder", "p5js");
      body.append("type", "temp");
      const resp = await api.fetchApi("/upload/image", {
        method: "POST",
        body,
      });
      if (resp.status !== 200) {
        const err = `Error uploading image: ${resp.status} - ${resp.statusText}`;
        alert(err);
        throw new Error(err);
      }
      return `p5js/${name} [temp]`;
    };
  },
});
