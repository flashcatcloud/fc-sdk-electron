import * as http from 'node:http';

/**
 * Local HTTP server used as a controllable destination for outbound requests made by the test app.
 * Exposes `GET /status/:code` so tests can drive any response status they need, plus `GET /hang`,
 * which accepts the request and never answers it.
 */
export class TestServer {
  private server: http.Server | null = null;
  private port = 0;
  // Sockets held open by `/hang` requests. `server.close()` waits for every connection to end, so
  // they have to be destroyed explicitly or `stop()` never resolves.
  private openSockets = new Set<import('node:net').Socket>();

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const match = req.method === 'GET' && req.url ? /^\/status\/(\d+)$/.exec(req.url) : null;
        if (match) {
          const status = Number(match[1]);
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else if (req.method === 'GET' && req.url === '/hang') {
          // Deliberately no response: the caller's span stays open for the rest of the test.
          this.openSockets.add(req.socket);
          req.socket.on('close', () => this.openSockets.delete(req.socket));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      });

      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server!.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
          resolve(this.port);
        } else {
          reject(new Error('Failed to get server port'));
        }
      });

      this.server.on('error', (error) => {
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      for (const socket of this.openSockets) {
        socket.destroy();
      }
      this.openSockets.clear();

      if (this.server) {
        this.server.close((error) => {
          if (error) {
            reject(error);
          } else {
            this.server = null;
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  urlFor(status: number): string {
    return `http://127.0.0.1:${this.port}/status/${status}`;
  }

  /** A request to this URL is accepted and never answered. */
  urlForHang(): string {
    return `http://127.0.0.1:${this.port}/hang`;
  }
}
