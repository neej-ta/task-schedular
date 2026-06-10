// Tiny mock REST API for the rest_pull / rest_push demos. No dependencies.
//   GET  /customers?page=&pageSize=  → paginated array of customer records
//   POST /customers                  → accepts a batch, returns { received }
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 4000);
const N = Number(process.env.RECORDS ?? 7);
const countries = ['US', 'UK', 'IN'];
const customers = Array.from({ length: N }, (_, i) => ({
  Name: `Rest User ${i}`,
  Email: `rest${i}@example.com`,
  Age: String(20 + (i % 40)),
  Country: countries[i % 3],
  CustomerCode: `REST${i}`,
  JoinDate: '02/02/2022',
}));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  if (req.method === 'GET' && url.pathname === '/customers') {
    const page = Number(url.searchParams.get('page') ?? 1);
    const pageSize = Number(url.searchParams.get('pageSize') ?? 100);
    const items = customers.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(items));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/customers') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let received = 0;
      try {
        const arr = JSON.parse(body || '[]');
        received = Array.isArray(arr) ? arr.length : 0;
      } catch {
        /* ignore */
      }
      console.log(`[mock-rest] received ${received} records`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received }));
    });
    return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200);
    res.end('ok');
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => console.log(`[mock-rest] listening on ${PORT}, ${N} records`));
