import { inngest } from "@/inngest/client";
import { generateRtlPatch, generateRtlPlan, recordUsageIfPresent } from "@/lib/rtl/model-router";
import { createSupabaseServiceRole } from "@/lib/supabase/server";

export const processRtlJob = inngest.createFunction(
  { id: "process-rtl-job", concurrency: { limit: 4 } },
  { event: "genrtl/rtl.requested" },
  async ({ event, step }) => {
    const { jobId, userId } = event.data as { jobId: string; userId: string };
    const supabase = createSupabaseServiceRole();

    try {
      const job = await step.run("load-job", async () => {
        const { data, error } = await supabase
          .from("rtl_jobs")
          .select("id, user_id, spec, title, status")
          .eq("id", jobId)
          .single();

        if (error || !data) {
          throw new Error(`job ${jobId} not found: ${error?.message ?? "unknown error"}`);
        }
        return data;
      });

      await step.run("mark-plan-started", async () => {
        await supabase
          .from("rtl_jobs")
          .update({ status: "plan_in_progress", updated_at: new Date().toISOString() })
          .eq("id", jobId);
      });

      const planResult = await step.run("generate-plan", async () => generateRtlPlan(job.spec));

      await step.run("persist-plan", async () => {
        await supabase
          .from("rtl_jobs")
          .update({
            plan: planResult.plan,
            status: "code_in_progress",
            updated_at: new Date().toISOString()
          })
          .eq("id", jobId);

        await recordUsageIfPresent(supabase, jobId, userId, "plan", planResult.usage);
      });

      const codeResult = await step.run("generate-patch", async () =>
        generateRtlPatch(job.spec, planResult.plan)
      );

      await step.run("persist-patch", async () => {
        await supabase
          .from("rtl_jobs")
          .update({
            code_patch: codeResult.patch,
            status: "succeeded",
            updated_at: new Date().toISOString(),
            error: null
          })
          .eq("id", jobId);

        await recordUsageIfPresent(supabase, jobId, userId, "code", codeResult.usage);
      });

      return { ok: true, jobId };
    } catch (error) {
      await step.run("mark-failed", async () => {
        await supabase
          .from("rtl_jobs")
          .update({
            status: "failed",
            error: error instanceof Error ? error.message : "unknown error",
            updated_at: new Date().toISOString()
          })
          .eq("id", jobId);
      });
      throw error;
    }
  }
);
