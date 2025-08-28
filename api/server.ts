import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Server } from '@modelcontextprotocol/sdk/server';
import { z } from 'zod';

// Token hentes sikkert fra Vercel env var
const FIGMA_TOKEN = process.env.FIGMA_ACCESS_TOKEN!;
if (!FIGMA_TOKEN) {
  console.warn('Missing FIGMA_ACCESS_TOKEN env var');
}

// Lille helper til Figma REST
async function figma(path: string, params?: Record<string, string>) {
  const url = new URL(`https://api.figma.com/v1/${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { headers: { 'X-Figma-Token': FIGMA_TOKEN } });
  if (!res.ok) throw new Error(`Figma ${res.status}: ${await res.text()}`);
  return res.json();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // MCP server (JSON envelopes – passer til @modelcontextprotocol/server-fetch)
  const server = new Server({ name: 'figma-mcp', version: '0.1.0' }, { transport: { type: 'json' } });

  // Tool 1: get-file
  server.tool(
    {
      name: 'get-file',
      description: 'Hent Figma file JSON',
      inputSchema: z.object({ fileKey: z.string().describe('Figma file key fra filens URL') })
    },
    async ({ fileKey }) => {
      const data = await figma(`files/${fileKey}`);
      return { content: [{ type: 'json', text: JSON.stringify(data) }] };
    }
  );

  // Tool 2: export-node (PNG/SVG)
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
      const data = await figma(`images/${fileKey}`, { ids: nodeId, format, scale: String(scale) });
      const url = data.images?.[nodeId];
      if (!url) throw new Error('Ingen billed-URL retur fra Figma');
      return { content: [{ type: 'text', text: url }] };
    }
  );

  // MCP envelope ind/ud
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const reply = await server.handleJSON(body);
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify(reply));
}
