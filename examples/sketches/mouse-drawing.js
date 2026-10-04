function setup() {
  createCanvas(512, 512);
  background(245);
}

function draw() {
  if (mouseIsPressed) {
    stroke('black');
    strokeWeight(7);
    line(pmouseX, pmouseY, mouseX, mouseY);
  }
}

function keyPressed() {
  if (key === " ") {
    background(245);
  }
}
