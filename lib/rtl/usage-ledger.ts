import type { SupabaseClient } from "@supabase/supabase-js";

export interface ModelUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
}

export const MODEL_PRICING: Record<
  string,
  {
    promptPer1M: number;
    completionPer1M: number;
  }
> = {
  "gpt-4o-mini": { promptPer1M: 0.15, completionPer1M: 0.6 },
  "gpt-4o": { promptPer1M: 5, completionPer1M: 15 }
};

export function calculateUsageCost(model: string, promptTokens: number, completionTokens: number) {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;

  const promptCost = (promptTokens / 1_000_000) * pricing.promptPer1M;
  const completionCost = (completionTokens / 1_000_000) * pricing.completionPer1M;

  return Number((promptCost + completionCost).toFixed(6));
}

export async function logUsageForJob(
  supabase: SupabaseClient,
  params: {
    jobId: string;
    userId: string;
    stage: "plan" | "code";
    usage: ModelUsage;
  }
) {
  const { jobId, userId, stage, usage } = params;

  const { error } = await supabase.from("model_usage_logs").insert({
    job_id: jobId,
    user_id: userId,
    stage,
    model: usage.model,
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
    cost_usd: usage.costUsd
  });

  if (error) {
    console.error("❌ Failed to record usage:", error);
  }

  const { data: currentJob } = await supabase
    .from("rtl_jobs")
    .select("total_tokens, estimated_cost_usd")
    .eq("id", jobId)
    .single();

  const { error: jobError } = await supabase.from("rtl_jobs").update({
    total_tokens: (currentJob?.total_tokens ?? 0) + usage.totalTokens,
    estimated_cost_usd: Number(((currentJob?.estimated_cost_usd ?? 0) + usage.costUsd).toFixed(6))
  }).eq("id", jobId);

  if (jobError) {
    console.error("❌ Failed to update job usage totals:", jobError);
  }
}
