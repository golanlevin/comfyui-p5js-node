# Examples

Small demo assets for testing `comfyui-p5js-node`.

These files are safe to leave in the repository when cloning into `ComfyUI/custom_nodes`: ComfyUI will ignore this directory during node loading.

## Workflows

### `workflows/p5-in-comfy-sd15-basic.json`

Recommended starting workflow for RunComfy/ComfyUI SD 1.5 testing.

Expected dependencies:

- `comfyui-p5js-node`
- Standard ComfyUI nodes
- A checkpoint named `RunComfyDefault/v1-5-pruned-emaonly.safetensors`, or a replacement checkpoint selected manually after loading

This workflow uses only stock ComfyUI node types plus this repository's `HYPE_P5JSImage` node.

The matching screenshot is:

```text
workflows/p5-in-comfy-sd15-basic.png
```

### `workflows/p5-in-comfy-sd15-overlay-legacy.json`

Older classroom workflow preserved for reference. It includes `Image Overlay`, which may come from a custom node pack and may not be available in a clean ComfyUI/RunComfy environment.

Use the basic workflow first.

## Sketches

The files in `sketches/` are plain p5.js examples that can be pasted into the node's script editor.

- `bugs.js`: static 512x512 landscape conditioning image
- `landscape.js`: static 512x512 landscape conditioning image
- `mouse-drawing.js`: interactive drawing surface; draw first, then queue the workflow


These sketches use core p5.js only. They do not use `p5.sound`.

## Screenshots

Place current RunComfy screenshots in `screenshots/` after verifying the workflows against the latest hosted environment.

Suggested screenshot names:

```text
screenshots/runcomfy-node-installed.png
screenshots/p5-node-preview.png
screenshots/workflow-wiring.png
screenshots/output-landscape.jpg
```

Keep screenshots reasonably small so cloning the custom node stays fast.
