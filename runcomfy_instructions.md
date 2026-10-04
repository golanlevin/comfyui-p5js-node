# comfyui-p5js-node on RunComfy

Instructions for using `comfyui-p5js-node` in a RunComfy.com cloud ComfyUI environment.

These notes are written for classroom use: students can run ComfyUI in the cloud, install this custom node, paste in a p5.js sketch, and use the sketch image to condition a Stable Diffusion workflow.

## What This Node Does

The node runs a p5.js sketch in an iframe inside ComfyUI. When the workflow is queued, the node captures the p5 canvas as a temporary PNG and passes that image to the rest of the ComfyUI graph.

This version loads core p5.js 2.3.4:

```html
https://cdn.jsdelivr.net/npm/p5@2.3.4/lib/p5.js
```

It does not load `p5.sound`. Sketches that use sound APIs, `loadSound()`, audio input, or the old bundled p5 1.x sound addon are not supported by default.

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

For a Stable Diffusion 1.5 image-conditioning workflow, use `createCanvas(512, 512)` unless your workflow explicitly resizes the input image.

## Starting RunComfy

1. Navigate to [RunComfy.com](https://www.runcomfy.com/).
2. Create an account and sign in.
3. Add funds if needed. A small amount is usually enough for a short classroom exercise.
4. Choose **My Workflows**.
5. Choose a ComfyUI workflow such as **ComfyUI-NodesLoaded**, then click **Run Workflow**.
6. Launch a suitable machine. A medium hobby machine is usually enough for basic SD 1.5 experiments.
7. Wait for the cloud machine to finish starting.

Before modifying the workflow, run RunComfy's default workflow once:

1. Hide the Assets panel if it blocks your view.
2. Click **Queue Prompt**.
3. Confirm that the default example generates an image.

This gives students a known-good baseline before installing the custom node.

## Installing the Custom Node

The most direct installation path is RunComfy's terminal.

1. Open the **Terminal** panel in RunComfy.
2. Go to the ComfyUI custom nodes folder:

```sh
cd custom_nodes
```

3. Clone this repository:

```sh
git clone https://github.com/golanlevin/comfyui-p5js-node.git
```

4. Click **Restart Comfy**.
5. Refresh the browser page.
6. In the Assets browser, confirm that `Home > ComfyUI > custom_nodes > comfyui-p5js-node` exists.
7. In the ComfyUI graph, right-click and add the `p5js image` node.

If you are testing a branch (*this is not common*):

```sh
cd custom_nodes
git clone https://github.com/golanlevin/comfyui-p5js-node.git
cd comfyui-p5js-node
git checkout BRANCH_NAME
```

<!--

To use this feature you need BOTH: (1) 'allow_git_url_install = true' in config.ini ([default] section), AND (2) ComfyUI launched with a loopback --listen (127.0.0.1 or ::1). Both values are read once at ComfyUI startup, so changing either one needs a restart, done with the server down: stop ComfyUI, change the setting, then start it again.


-->

RunComfy also supports uploading a prepared custom node folder into `custom_nodes` through its file browser.

## Minimal Node Test

After installing, paste this sketch into the node:

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

## Example Image-Conditioning Workflow

Start from RunComfy's default SD 1.5 workflow, then modify it so the p5 image becomes the image input to the diffusion graph.

This repository also includes example assets in [examples/](examples/). Start with `examples/workflows/p5-in-comfy-sd15-basic.json` and the sketches in `examples/sketches/`.

Typical nodes to add or connect:

1. `p5js image`
2. `VAE Encode`
3. `Preview Image`
4. `Save Image`

A common pattern is:

```text
p5js image -> VAE Encode -> KSampler latent image input
p5js image -> Preview Image
KSampler -> VAE Decode -> Save Image
```

For a first text prompt, try:

```text
Rolling hills, foggy day, cloudy sky, mountains with trees
```

The exact node names and wiring may vary with RunComfy's current default workflow, but the key idea is that the p5 node outputs an `IMAGE`, and `VAE Encode` converts that image into the latent representation used by the sampler.

## Classroom Landscape Sketch

This visual-only p5 sketch is suitable for a first conditioning test:

```js
function setup() {
  createCanvas(512, 512);
  noLoop();
}

function draw() {
  background("lightblue");
  ellipseMode(CENTER);
  noStroke();

  let colA = color(173, 216, 230);
  let colB = color(47, 79, 79);
  let nHills = 7;
  for (let i = 1; i <= nHills; i++) {
    let t = map(i, 0, nHills, 0, 1);
    let col = lerpColor(colA, colB, t);
    fill(col);
    let ry = map(pow(t, 1.5), 0, 1, 250, 500) + t * 10 * random(-1, 1);
    let rx = 300 * random(-1, 1);
    let rw = width * random(2.5, 3.5);
    ellipse(width / 2 + rx, ry, rw, height * random(0.4, 0.5));
  }
}
```

I recommend developing and debugging sketches first in a dedicated p5.js editor such as the p5.js Web Editor, OpenProcessing, or a local editor. The ComfyUI node is best treated as the place where an already-working sketch is run inside an image-generation workflow.

## Troubleshooting

If the `p5js image` node does not appear, restart ComfyUI and refresh the browser.

If the iframe is blank, press **Run Sketch** and check that your sketch calls `createCanvas()`.

If **Queue Prompt** fails, run the sketch manually first, then queue again.

If the output dimensions matter, connect the p5 node to a `Preview Image` node and inspect the result before a long generation run.

If an older sketch behaves strangely, check whether it relies on p5 1.x behavior or `p5.sound`.
