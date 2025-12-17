import OpenAI from "openai";
import type { ChatCompletion } from "openai/resources/index.mjs";

import type { SupabaseClient } from "@supabase/supabase-js";

import { calculateUsageCost, logUsageForJob, type ModelUsage } from "./usage-ledger";

export interface RtlPlan {
  summary: string;
  modules: Array<{
    name: string;
    description: string;
    interfaces: string[];
    dependencies?: string[];
  }>;
  verification: {
    testbenches: string[];
    edge_cases: string[];
  };
}

export interface PlanResult {
  plan: RtlPlan;
  usage?: ModelUsage;
}

export interface CodeResult {
  patch: string;
  usage?: ModelUsage;
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const PLAN_SCHEMA = {
  name: "rtl_plan",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "modules", "verification"],
    properties: {
      summary: { type: "string" },
      modules: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["name", "description", "interfaces"],
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            interfaces: { type: "array", items: { type: "string" } },
            dependencies: { type: "array", items: { type: "string" } }
          }
        }
      },
      verification: {
        type: "object",
        required: ["testbenches", "edge_cases"],
        properties: {
          testbenches: { type: "array", items: { type: "string" } },
          edge_cases: { type: "array", items: { type: "string" } }
        }
      }
    }
  }
} as const;

function extractUsage(model: string, completion: ChatCompletion | null): ModelUsage | undefined {
  if (!completion?.usage) return undefined;

  const promptTokens = completion.usage.prompt_tokens ?? 0;
  const completionTokens = completion.usage.completion_tokens ?? 0;
  const totalTokens = completion.usage.total_tokens ?? promptTokens + completionTokens;

  return {
    model,
    promptTokens,
    completionTokens,
    totalTokens,
    costUsd: calculateUsageCost(model, promptTokens, completionTokens)
  };
}

export async function generateRtlPlan(spec: string): Promise<PlanResult> {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    response_format: {
      type: "json_schema",
      json_schema: PLAN_SCHEMA
    },
    messages: [
      {
        role: "system",
        content:
          "You are a senior RTL architect. Break the specification into RTL modules, summarize responsibilities, and outline verification tasks. Keep module names concise and describe signal interfaces explicitly."
      },
      {
        role: "user",
        content: `Specification:\n${spec}`
      }
    ]
  });

  const message = completion.choices[0]?.message?.content ?? "";
  let plan: RtlPlan;

  try {
    plan = JSON.parse(message || "{}") as RtlPlan;
  } catch (error) {
    throw new Error(
      `Failed to parse plan output: ${(error as Error).message}. Raw content: ${message}`
    );
  }

  return {
    plan,
    usage: extractUsage("gpt-4o-mini", completion)
  };
}

export async function generateRtlPatch(spec: string, plan: RtlPlan): Promise<CodeResult> {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.25,
    messages: [
      {
        role: "system",
        content:
          "You are an RTL implementation specialist. Produce a unified diff patch (---/+++) with SystemVerilog files implementing the plan. Include minimal, compilable modules and basic testbench stubs."
      },
      {
        role: "user",
        content: `Specification:\n${spec}\n\nPlan:\n${JSON.stringify(plan, null, 2)}`
      }
    ]
  });

  const patch = completion.choices[0]?.message?.content ?? "";

  if (!patch.trim()) {
    throw new Error("Model returned an empty patch for the RTL job");
  }

  return {
    patch,
    usage: extractUsage("gpt-4o", completion)
  };
}

export async function recordUsageIfPresent(
  supabase: SupabaseClient,
  jobId: string,
  userId: string,
  stage: "plan" | "code",
  usage?: ModelUsage
) {
  if (!usage) return;
  await logUsageForJob(supabase, {
    jobId,
    userId,
    stage,
    usage
  });
}
