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

    let rx = 320 * random(-1, 1);
    let ry = map(pow(t, 1.5), 0, 1, 250, 500) +  
      t * 15 * random(-1, 1);
    let rw = width * random(2.5, 3.5);
    ellipse(width / 2 + rx, ry, rw, 
            height * random(0.3, 0.5));
  }
}

function keyPressed() {
  if (key === " ") {
    draw();
  }
}