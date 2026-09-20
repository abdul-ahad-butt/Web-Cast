const fs = require('fs');
const path = require('path');

const webmBase64 = 'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGkVfAWL4gQCGh4EFQpaBAk7XgQlCvYEDQpeBA1vPgQJDr4EFQpCBBEx1ZGFzaF92aWRlb0FDRBpF36OToKCDgQEA2IETQpeBA0fHgQRAiIiICUuBA4MAABsAAABcAAAAAAARAAABAAAAAAAAAAAAAAAARAAABAAAAAAAAAAAAAAAARAAAA==';

const buf = Buffer.from(webmBase64, 'base64');
fs.mkdirSync('e2e', { recursive: true });
fs.writeFileSync(path.join('e2e', 'test.webm'), buf);
console.log('Created e2e/test.webm');
