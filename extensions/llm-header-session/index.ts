import * as fsStream from "fs";
import * as fs from "fs/promises";
import os from "os";
import * as path from "path";
import { URL } from "url";

export function register(api: any) {
  api.logger.info("simple-media-download plugin registered");

  // 1. 固定兜底媒体根目录：~/.openclaw/media
  const homeDir = os.homedir();
  const mediaRoot = path.join(homeDir, ".openclaw", "media");
  const MEDIA_INBOUND_DIR = path.join(mediaRoot, "inbound");
  api.logger.info("媒体存储目录", MEDIA_INBOUND_DIR);

  // 自动创建 inbound 目录
  fs.mkdir(MEDIA_INBOUND_DIR, { recursive: true }).catch((err) => {
    api.logger.warn("媒体目录创建警告", err.message);
  });

  // 注册无鉴权下载路由
  api.registerHttpRoute({
    path: "/plugin/media/download",
    method: "GET",
    auth: "plugin",
    match: "exact",
    handler: async (req: any, res: any) => {
      try {
        // 手动解析URL参数，规避req.query失效问题
        const fullBaseUrl = `http://localhost:18789`;
        const urlObj = new URL(req.url, fullBaseUrl);
        const fileId = urlObj.searchParams.get("fileId");
        api.logger.info("解析到fileId", fileId);

        if (!fileId || typeof fileId !== "string" || fileId.trim() === "") {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "缺少合法 fileId 参数" }));
        }

        // 拼接文件绝对路径
        const targetFile = path.resolve(MEDIA_INBOUND_DIR, fileId);
        // 防路径穿越攻击
        if (!targetFile.startsWith(MEDIA_INBOUND_DIR)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "非法文件访问路径" }));
        }

        // 判断文件是否存在
        await fs.access(targetFile);
        const stat = await fs.stat(targetFile);

        // 下载响应头
        res.setHeader("Content-Length", stat.size);
        res.setHeader("Content-Disposition", `attachment; filename="${fileId}"`);

        // 文件流输出
        const readStream = fsStream.createReadStream(targetFile);
        readStream.pipe(res);

        readStream.on("error", (err) => {
          api.logger.error("文件流读取失败", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "文件读取异常" }));
        });
      } catch (err: any) {
        api.logger.error("下载接口全局异常", err);
        if (err.code === "ENOENT") {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "文件不存在" }));
        }
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "服务器内部错误" }));
      }
    },
  });
}

/**
 * media://inbound/xxx 转换为可下载URL
 * @param mediaUri media://inbound/xxx 原始标识
 * @returns 完整http下载链接
 */
export function getMediaDownloadUrl(mediaUri: string): string {
  const prefix = "media://inbound/";
  const fileId = mediaUri.slice(prefix.length);
  return `http://localhost:18789/plugin/media/download?fileId=${encodeURIComponent(fileId)}`;
}
