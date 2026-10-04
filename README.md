# comfyui-p5js-node

Custom ComfyUI node for running a p5.js sketch and passing its canvas pixels into a ComfyUI image workflow.

This version loads core p5.js 2.3.4:

```html
https://cdn.jsdelivr.net/npm/p5@2.3.4/lib/p5.js
```

*Note: this node does not load `p5.sound`. Sketches that use sound APIs are not supported by default.*

## What This Is

The node lets you paste a p5.js sketch into ComfyUI, render the sketch in an iframe, capture the default p5 canvas, and feed that image into the rest of a ComfyUI graph. For example, the p5 image can become the starting image for an img2img workflow or a visual guide for a diffusion model.

## What This Is Not

This is not a full p5.js development environment. It does not provide p5 reference docs, sketch debugging, asset management, sound support, or a browser console inside the node. Test sketches separately if they are complicated, then paste working code into the node.

## Sketch Requirements

Use ordinary global-mode p5.js sketches that create a canvas in `setup()`:

```js
function setup() {
  createCanvas(512, 512);
}

function draw() {
  background(220);
  fill(40);
  circle(width / 2, height / 2, 180);
}
```

The node captures p5's default canvas, currently expected to have the browser id `defaultCanvas0`. It exports the image at the canvas's displayed p5 size, so a `createCanvas(512, 512)` sketch should produce a 512x512 image even on high-DPI displays.

Because this version uses p5.js 2.3.4, older p5 1.x sketches may need updates.

## How It Works

1. Paste a p5.js sketch into the node's script editor.
2. Press **Run Sketch** to save the sketch into ComfyUI's temporary `p5js` folder and reload the preview iframe.
3. Press **Queue Prompt** to execute the workflow. If the sketch has not been run yet, the node tries to run it automatically before capturing the canvas.
4. The captured canvas is uploaded as a temporary image and passed to ComfyUI as the node output.

## Recommended Test

After installing, test the node with this sketch:

```js
function setup() {
  createCanvas(512, 512);
}

function draw() {
  background("AntiqueWhite");
  noStroke();

  fill("LightSlateGray");
  rect(0, 0, width, 220);

  fill(70, 40, 10);
  ellipse(220, 430, 200, 80);
  fill(90, 60, 15);
  ellipse(370, 340, 120, 60);
}
```

Check that:

1. **Run Sketch** shows the p5 canvas in the iframe.
2. Panning and zooming the ComfyUI canvas keeps the iframe aligned with the node.
3. Clicking and typing in the code editor does not drag the node.
4. **Queue Prompt** captures the p5 canvas and passes it to the next image node.
5. A workflow with two p5 nodes captures two separate sketches correctly.


## Examples

See [examples/](examples/) for sample p5 sketches and ComfyUI workflows.

## Local Installation

For local ComfyUI use, clone this repository into `ComfyUI/custom_nodes`:

```sh
cd ComfyUI/custom_nodes
git clone https://github.com/YOUR_ACCOUNT/comfyui-p5js-node.git
```

Then restart ComfyUI.

## For RunComfy.com

For RunComfy-specific classroom/cloud instructions, see [runcomfy_instructions.md](runcomfy_instructions.md).

## Notes for Maintainers

The preview iframe lives in `web/preview/index.html`. The ComfyUI frontend extension lives in `web/js/p5jsimage.js`. The Python node wrapper lives in `p5jsimage.py`.

The iframe uses ComfyUI's `addDOMWidget` API so the preview remains attached to the node while panning and zooming. The script editor is upgraded to CodeMirror and stops pointer events from bubbling into ComfyUI's canvas so editing code does not start a node drag.
