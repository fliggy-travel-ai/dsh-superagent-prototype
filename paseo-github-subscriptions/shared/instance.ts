/**
 * 实例角色文件。部署脚本（scripts/deploy.ts）在部署目录中改写本文件，仓库中保持 null。
 *
 * - `null`：没有写入角色（兼容模式）。按 main 处理，并保留云端会话，直到部署时写入角色。
 * - `"main"`：页面和除 Provider 以外的全部模块，安装 ID `github-subscriptions`。
 * - `"provider"`：只运行 Provider 模块，安装 ID `dev-automation-providers`。
 *
 * 插件代码读不到自己的安装 ID，所以角色只能由部署目录中的这个文件决定。
 */
export const INSTANCE_ROLE: 'main' | 'provider' | null = null;
