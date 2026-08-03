const http = require('http');
const data = JSON.stringify({ url: 'https://getbootstrap.com', maxPages: 5 });
const options = {
  hostname: 'localhost', port: 3456, path: '/scan-all',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
};
const req = http.request(options, res => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    const d = JSON.parse(body);
    console.log('Status:', res.statusCode);
    console.log('Total pages:', d.totalPages);
    (d.pages || []).forEach(p => console.log(' -', p.title || '?', ':', (p.issues || []).length, 'issues'));
    console.log('Comparisons:', (d.crossPageComparisons || []).length);
  });
});
req.on('error', e => console.error('Error:', e.message));
req.write(data);
req.end();
