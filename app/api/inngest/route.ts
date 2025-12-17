import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { generateMedia } from "@/inngest/functions/generate";
import { cleanupJobs } from "@/inngest/functions/cleanup";
import { generateLongVideo } from "@/inngest/functions/generate-long-video";
import { processAccountDeletion } from "@/inngest/functions/delete-account";
import { processRtlJob } from "@/inngest/functions/generate-rtl";

// Inngest serve 会自动从环境变量 INNGEST_SIGNING_KEY 读取签名密钥
// 不需要手动传入 signingKey 参数
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [generateMedia, cleanupJobs, generateLongVideo, processAccountDeletion, processRtlJob]
});
