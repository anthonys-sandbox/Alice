import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { registerTool } from '../runtime/tools/registry.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('MCP');

export interface MCPServerConfig {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    enabled?: boolean;
}

interface MCPConnection {
    config: MCPServerConfig;
    client: Client;
    transport: StdioClientTransport;
    tools: string[];
}

/**
 * Manages connections to multiple MCP servers.
 * Discovers their tools and registers them in Alice's tool registry.
 */
export class MCPManager {
    private connections: Map<string, MCPConnection> = new Map();

    /**
     * Connect to all configured MCP servers.
     */
    async connectAll(servers: MCPServerConfig[]): Promise<void> {
        const enabled = servers.filter(s => s.enabled !== false);
        if (enabled.length === 0) {
            log.debug('No MCP servers configured');
            return;
        }

        log.info(`Connecting to ${enabled.length} MCP servers...`);

        const results = await Promise.allSettled(
            enabled.map(server => this.connect(server))
        );

        const succeeded = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.filter(r => r.status === 'rejected').length;
        log.info(`MCP servers: ${succeeded} connected, ${failed} failed`);
    }

    /**
     * Connect to a single MCP server and register its tools.
     */
    async connect(config: MCPServerConfig): Promise<void> {
        try {
            log.info(`Connecting to MCP server: ${config.name}`, { command: config.command });

            const transport = new StdioClientTransport({
                command: config.command,
                args: config.args,
                env: { ...process.env as Record<string, string>, ...(config.env || {}) },
                cwd: config.cwd,
                stderr: 'pipe',
            });

            const client = new Client(
                { name: 'alice-agent', version: '1.0.0' },
                { capabilities: {} }
            );

            await client.connect(transport);
            log.info(`Connected to MCP server: ${config.name}`);

            // Discover and register tools
            const toolNames = await this.discoverAndRegisterTools(config.name, client);

            this.connections.set(config.name, {
                config,
                client,
                transport,
                tools: toolNames,
            });

            log.info(`MCP server "${config.name}" ready with ${toolNames.length} tools`, {
                tools: toolNames,
            });
        } catch (err: any) {
            log.error(`Failed to connect to MCP server: ${config.name}`, { error: err.message });
            throw err;
        }
    }

    /**
     * Discover tools from an MCP server and register them in Alice's registry.
     */
    private async discoverAndRegisterTools(serverName: string, client: Client): Promise<string[]> {
        const result = await client.listTools();
        const toolNames: string[] = [];

        for (const tool of result.tools) {
            const aliceToolName = `mcp_${serverName}_${tool.name}`;
            toolNames.push(aliceToolName);

            registerTool({
                name: aliceToolName,
                description: `[MCP:${serverName}] ${tool.description || tool.name}`,
                parameters: tool.inputSchema || { type: 'object', properties: {}, required: [] },
                execute: async (args: Record<string, any>) => {
                    try {
                        const callResult = await client.callTool({
                            name: tool.name,
                            arguments: args,
                        });

                        // Extract text content from MCP response
                        if ('content' in callResult && Array.isArray(callResult.content)) {
                            const textParts = callResult.content
                                .filter((c: any) => c.type === 'text')
                                .map((c: any) => c.text);

                            const imageParts = callResult.content
                                .filter((c: any) => c.type === 'image')
                                .map((c: any) => `![MCP Image](data:${c.mimeType};base64,${c.data})`);

                            return [...textParts, ...imageParts].join('\n\n') || 'Tool completed (no text output).';
                        }

                        // Fallback for older format
                        if ('toolResult' in callResult) {
                            return String((callResult as any).toolResult);
                        }

                        return JSON.stringify(callResult);
                    } catch (err: any) {
                        log.error(`MCP tool call failed: ${aliceToolName}`, { error: err.message });
                        return `Error calling MCP tool ${tool.name}: ${err.message}`;
                    }
                },
            });

            log.debug(`Registered MCP tool: ${aliceToolName}`);
        }

        return toolNames;
    }

    /**
     * Disconnect from all MCP servers.
     */
    async disconnectAll(): Promise<void> {
        for (const [name, conn] of this.connections) {
            try {
                await conn.client.close();
                log.info(`Disconnected from MCP server: ${name}`);
            } catch (err: any) {
                log.debug(`Error disconnecting from ${name}`, { error: err.message });
            }
        }
        this.connections.clear();
    }

    /**
     * Get the names of all connected servers.
     */
    getConnectedServers(): string[] {
        return Array.from(this.connections.keys());
    }

    /**
     * Get all registered MCP tool names.
     */
    getAllTools(): string[] {
        return Array.from(this.connections.values()).flatMap(c => c.tools);
    }
}
