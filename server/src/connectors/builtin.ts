import type { ConnectorDef } from '@agentic/core';

/**
 * The connectors that ship with the app.
 *
 * Each is an MCP server the user already has, or one npx will fetch. They are
 * declared rather than implemented, which is the point of ADR 0002 applied to
 * integrations: GitHub, Miro and Figma are config objects, and adding Linear or
 * Slack is another entry in this array.
 *
 * Every one has `writeRequiresApproval: true`. Reading a Figma file or a GitHub
 * issue is routine; opening a PR, posting a message or writing a design frame
 * is an outward action, and those wait for a person in every execution mode.
 */
export const BUILTIN_CONNECTORS: ConnectorDef[] = [
  {
    id: 'github',
    name: 'GitHub',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    requiredSecrets: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    enabled: false,
    writeRequiresApproval: true,
  },
  {
    id: 'figma',
    name: 'Figma',
    transport: 'http',
    // Figma's own MCP server runs alongside the desktop app on this port.
    url: 'http://127.0.0.1:3845/mcp',
    requiredSecrets: [],
    enabled: false,
    writeRequiresApproval: true,
  },
  {
    id: 'miro',
    name: 'Miro',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@k-jarzyna/mcp-miro'],
    requiredSecrets: ['MIRO_ACCESS_TOKEN'],
    enabled: false,
    writeRequiresApproval: true,
  },
  {
    id: 'linear',
    name: 'Linear',
    transport: 'http',
    url: 'https://mcp.linear.app/sse',
    requiredSecrets: [],
    enabled: false,
    writeRequiresApproval: true,
  },
  {
    id: 'slack',
    name: 'Slack',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    requiredSecrets: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
    enabled: false,
    writeRequiresApproval: true,
  },
  {
    id: 'filesystem',
    name: 'Filesystem (read-only, outside the project)',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    requiredSecrets: [],
    enabled: false,
    writeRequiresApproval: true,
  },
];
