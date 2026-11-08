import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const proxy = {
  '/api': {
    target: 'http://127.0.0.1:47821', changeOrigin: true,
    configure(server: any) {
      server.on('proxyReq', (request: any) => {
        try { request.setHeader('Authorization', `Bearer ${readFileSync(join(process.env.NERVO_DATA_DIR || join(process.env.LOCALAPPDATA || '', 'Nervo'), 'access-token'), 'utf8').trim()}`); }
        catch { /* The UI reports that the backend is unavailable. */ }
      });
    },
  },
};
export default defineConfig({plugins:[react()],server:{host:'127.0.0.1',port:5177,strictPort:true,proxy},preview:{host:'127.0.0.1',port:5177,strictPort:true,proxy}});
