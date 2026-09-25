const puppeteer = require('puppeteer');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
  
  await page.goto('http://localhost:5173');
  
  // click generate room
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const gen = btns.find(b => b.textContent.includes('Generate New'));
    if (gen) gen.click();
  });
  
  await wait(1000);
  
  // get room code
  const roomCode = await page.evaluate(() => {
    const input = document.querySelector('input[placeholder="Enter Room Code"]');
    return input ? input.value : null;
  });
  
  console.log('Room code:', roomCode);
  
  if (roomCode) {
    const rxPage = await browser.newPage();
    rxPage.on('console', msg => console.log('RX LOG:', msg.text()));
    rxPage.on('pageerror', err => console.log('RX ERROR:', err.message));
    await rxPage.goto('http://localhost:5173/receiver/' + roomCode);
    
    await wait(2000);
    
    // cast local media
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('h2'));
      const cast = btns.find(b => b.textContent.includes('Cast Local Media'));
      if (cast) cast.parentElement.click();
    });
    
    await wait(5000);
  }
  
  await browser.close();
})();
