function setup() {
  createCanvas(512, 512);
  noLoop();
}

function draw() {
  background('LightSlateGray'); 
  noStroke(); 
  fill('AntiqueWhite'); 
  ellipse(250,400,1200,350); 
  
  // Let's draw some "bugs". 
  for (let i=0; i<2; i++){
    let rr = random(60,90); 
    let rg = random(30,65); 
    let rb = random(10,45); 
    fill(rr,rg,rb); 
    let bx = width * ((i+1)/3) + random(-25,25);
    let by = height * random(0.65, 0.80); 
    let diam = random(100,150); 
    ellipse(bx,by, diam, diam*0.6); 
  }
}

function keyPressed() {
  if (key === " ") {
    draw(); 
  }
}