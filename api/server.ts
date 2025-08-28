import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Server } from '@modelcontextprotocol/sdk/server';
import { z } from 'zod';

const FIGMA_TOKEN = process.env.FIGMA_ACCESS_TOKEN;

function cors(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Lille helper til Figma REST API
async function figma(path: string, params?: Record<string, string>) {
  if (!FIGMA_TOKEN) {
    throw new Error('FIGMA_ACCESS_TOKEN mangler i environment variables');
  }
  const url = new URL(`https://api.figma.com/v1/${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: { 'X-Figma-Token': FIGMA_TOKEN }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Figma ${res.status}: ${text}`);
  }
  return res.json();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  cors(res);
  
  // OPTIONS preflight
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  // GET for SSE initialization (Claude MCP SSE transport)
  if (req.method === 'GET') {
    // SSE headers for MCP transport
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Cache-Control');
    
    // Send initial SSE data for MCP capability discovery
    res.write('data: {"jsonrpc":"2.0","method":"initialized","params":{}}\n\n');
    
    // Keep connection alive for MCP
    const keepAlive = setInterval(() => {
      res.write('data: {"jsonrpc":"2.0","method":"ping"}\n\n');
    }, 30000);
    
    // Cleanup on close
    req.on('close', () => {
      clearInterval(keepAlive);
      res.end();
    });
    
    return;
  }
  
  // POST for MCP JSON-RPC calls
  if (req.method === 'POST') {
    const server = new Server(
      { name: 'figma-mcp', version: '0.1.0' },
      { transport: { type: 'json' } }
    );

    // Tool 1: get-file
    server.tool(
      {
        name: 'get-file',
        description: 'Hent Figma file JSON',
        inputSchema: z.object({
          fileKey: z.string().describe('Figma file key (fra filens URL)')
        })
      },
      async ({ fileKey }) => {
        const data = await figma(`files/${fileKey}`);
        return { content: [{ type: 'json', text: JSON.stringify(data, null, 2) }] };
      }
    );

    // Tool 2: export-node
    server.tool(
      {
        name: 'export-node',
        description: 'Eksportér en node som PNG/SVG via Figma images API',
        inputSchema: z.object({
          fileKey: z.string(),
          nodeId: z.string(),
          format: z.enum(['png', 'svg']).default('png'),
          scale: z.number().min(0.1).max(4).default(1)
        })
      },
      async ({ fileKey, nodeId, format, scale }) => {
        const data = await figma(`images/${fileKey}`, {
          ids: nodeId,
          format,
          scale: String(scale)
        });
        const url = data.images?.[nodeId];
        if (!url) throw new Error('Ingen billed-URL retur fra Figma');
        return { content: [{ type: 'text', text: url }] };
      }
    );

    // Handle MCP JSON-RPC
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!body) {
      return res.status(400).json({ error: 'Missing JSON body' });
    }

    try {
      const reply = await server.handleJSON(body);
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json(reply);
    } catch (err: any) {
      console.error('MCP handler error:', err);
      return res.status(500).json({ error: String(err?.message || err) });
    }
  }

  // Fallback health check
  return res.status(200).json({ 
    ok: true, 
    server: 'figma-mcp', 
    env: !!FIGMA_TOKEN,
    methods: ['GET (SSE)', 'POST (JSON-RPC)']
  });
}
