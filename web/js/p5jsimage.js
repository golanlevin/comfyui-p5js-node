import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { $el } from "/scripts/ui.js";

const p5jsPreviewSrc = new URL(`../preview/index.html`, import.meta.url);
const P5JS_MESSAGE_SOURCE = "comfyui-p5js-node";
let canvasCaptureRequestId = 0;

async function saveSketch(filename, srcCode) {
  try {
    const blob = new Blob([srcCode], { type: "text/plain" });
    const file = new File([blob], filename + ".js");
    const body = new FormData();
    body.append("image", file);
    body.append("subfolder", "p5js");
    body.append("type", "temp");
    body.append("overwrite", "true"); //can also be set to 1
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
} //end saveSketch

function findP5Canvas(doc) {
  return doc?.getElementById("defaultCanvas0") || doc?.querySelector("canvas");
}

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

function clearConsolePane(pane) {
  if (pane?._output) {
    pane._output.textContent = "";
  }
}

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

function attachPreviewConsole(iframe, pane) {
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

// Poll the iframe document until p5.js has created its canvas, or time out.
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

function getCanvasExportSize(canvas) {
  const width = Math.round(canvas.clientWidth || canvas.width);
  const height = Math.round(canvas.clientHeight || canvas.height);
  return {
    width: Math.max(1, width),
    height: Math.max(1, height),
  };
}

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

// Save the current script and (re)load it into the iframe so p5.js runs it.
async function loadSketch(iframe, sketchfile, srcCode) {
  await saveSketch(sketchfile, srcCode);
  iframe.src = p5jsPreviewSrc + "?sketch=" + sketchfile + ".js";
}

// Save the current script, reload it into the iframe, and wait for a capture.
async function runSketch(iframe, sketchfile, srcCode) {
  await loadSketch(iframe, sketchfile, srcCode);
  return waitForCanvas(iframe);
}

// Lazy-load CodeMirror 6 (only once, shared across all nodes).
let codeMirrorPromise = null;
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

  const initialValue = widget.value ?? target.value ?? "";

  const container = document.createElement("div");
  container.style.cssText =
    "width: 100%; height: 100%; min-height: 200px; overflow: hidden;" +
    "box-sizing: border-box; border-radius: 4px; cursor: text;";

  target.parentNode.replaceChild(container, target);

  const editor = new EditorView({
    doc: initialValue,
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
          // Push the new text back into the widget via its existing setter,
          // which keeps ComfyUI's prompt serialization in sync.
          widget.value = editor.state.doc.toString();
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
}

// Kick off the CDN fetch early so the editor is ready by the time a node is created.
loadCodeMirror();

app.registerExtension({
  name: "HYPE_P5JSImage",

  getCustomWidgets(app) {
    return {
      P5JS(node, inputName) {
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

        node.serialize_widgets = false;

        //add run sketch button first so it sits above the iframe
        const btn = node.addWidget(
          "button",
          "Run Sketch",
          "run_p5js_sketch",
          () => {
            clearConsolePane(consolePane);
            loadSketch(iframe, sketchfile, node.widgets[0].value)
              .then(() => captureCanvasFromIframe(iframe))
              .catch((e) => {
                const err = `Error running p5.js sketch: ${e.message || e}`;
                alert(err);
                console.error(err, e);
              });
          }
        );
        btn.serializeValue = () => undefined;

        // addDOMWidget mounts the iframe inside ComfyUI's DOM-widget container,
        // which is automatically positioned/scaled by ComfyUI as the canvas pans and zooms.
        const widget = node.addDOMWidget("image", "P5JS", iframe, {
          hideOnZoom: false,
          getMinHeight: () => 400,
        });
        widget.sketchfile = sketchfile;
        widget.consolePane = consolePane;
        widget.detachConsole = detachConsole;

        const consoleWidget = node.addDOMWidget(
          "p5js_console",
          "P5JS Console",
          consolePane,
          {
            hideOnZoom: false,
            getMinHeight: () => 120,
          },
        );
        consoleWidget.serializeValue = () => undefined;

        return widget;
      },
    };
  },

  nodeCreated(node) {
    if (node.constructor.comfyClass !== "HYPE_P5JSImage") return;

    //upgrade the script textarea to a CodeMirror editor
    const scriptWidget = node.widgets.find((w) => w.name === "script");
    if (scriptWidget) {
      attachCodeMirror(scriptWidget).catch((e) => {
        console.error("Failed to mount CodeMirror editor:", e);
      });
    }

    //get the p5js widget
    const p5jsWidget = node.widgets.find((w) => w.name === "image");

    //add serialize method here....
    p5jsWidget.serializeValue = async () => {
      //get the canvas from iframe
      const theFrame = p5jsWidget.element;
      let canvas = null;
      try {
        const iframe_doc =
          theFrame.contentDocument || theFrame.contentWindow.document;
        canvas = findP5Canvas(iframe_doc);
      } catch (e) {
        console.debug("Direct iframe canvas lookup failed; using capture bridge.", e);
      }
      let blob = canvas ? await canvasToPngBlob(canvas) : null;

      // If the sketch has never been run (no canvas yet), run it now so the
      // workflow still works without the user clicking "Run Sketch" first.
      if (!blob) {
        const scriptWidget = node.widgets.find((w) => w.name === "script");
        clearConsolePane(p5jsWidget.consolePane);
        await loadSketch(
          theFrame,
          p5jsWidget.sketchfile,
          scriptWidget ? scriptWidget.value : node.widgets[0].value,
        );
        blob = await captureCanvasFromIframe(theFrame);
      }

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
