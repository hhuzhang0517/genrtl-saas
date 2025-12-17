# genRTL

# 简介

genRTL 后端是一套基于 genRTL-saas 模板构建的云端服务，负责整个自动 RTL 流程的在线推理和管理工作。它为客户端提供 HTTP API 接口，实现用户认证/订阅、任务调度、LLM 模型调用以及使用量计费等功能。后端将用户提交的设计 Spec 转化为具体实现方案与代码，通过 GPT-5.1 和 Claude 等大模型分工合作来生成结果，并对每次模型调用进行记录以支持计费。下文详细介绍后端各组件的架构设计，以及一次任务从接收 → 调度 → 推理 → 返回 → 计费的完整处理流程。

# 系统架构

下图展示了 genRTL SaaS 后端的主要模块及其交互关系：

graph LR
    Client[客户端 Agent] -- 提交 Spec --> API[API 网关/服务器]
    subgraph 后端服务
        API -->|验证用户| Auth[Auth & Subscription<br/>认证与订阅]
        API -->|触发任务| Dispatcher[Job Dispatcher<br/>(Inngest Workflow)]
        Auth -- 订阅检查 --> API
        Dispatcher --> PlanTask[Plan 步骤<br/>(GPT-5.1)]
        Dispatcher --> CodeTask[Code 步骤<br/>(Claude)]
        PlanTask -- 调用 --> GPT[GPT-5.1 模型 API]
        CodeTask -- 调用 --> Claude[Claude 模型 API]
        PlanTask -->|Plan 结果| CBB[CBB Registry<br/>模板库]
        CBB -- 提供模板 --> CodeTask
        CodeTask -->|代码 Patch| Result[结果缓冲]
        Result -->|返回 Patch| API
        Result -->|记录用量| UsageLedger[Usage Ledger<br/>使用记录]
        UsageLedger --> Billing[Billing<br/>计费处理]
        Dispatcher -. 可选调用 .-> CloudTool[云端 ToolRunner]
    end
    API -- Patch 响应 --> Client
    classDef module fill:#f9f,stroke:#333;
    classDef datastore fill:#bbf,stroke:#333;
    Auth,Dispatcher,PlanTask,CodeTask,CBB,UsageLedger,Billing,CloudTool class module;
    API,Result class datastore;
    classDef external fill:#ffd,stroke:#333;
    GPT,Claude class external;


图：genRTL 后端架构 – 请求首先经过 API 网关，验证用户身份和订阅状态后，交由 Job Dispatcher（基于 Inngest 等工作流引擎）调度执行任务。Dispatcher 按照预定义的任务流程依次触发 Plan 步骤和 Code 步骤。其中 模型路由 逻辑确保 Plan 阶段调用 GPT-5.1 模型，Code 阶段调用 Claude 模型，各自完成规划和代码生成。Plan 结果可能需要从 CBB 模板库 检索复用的代码块供生成器参考。最终 Code 步骤产出代码 Patch 结果，通过 API 返回客户端。同时，每次模型调用的 Token 用量都会记录到 Usage Ledger（使用账本），供后续 Billing 模块计费使用。整个过程中还支持 云端 ToolRunner（可选）用于在云端执行 Lint/Sim 等验证任务，实现端到端全自动化。下面对各组件功能详述。

# 主要组件详解
# Auth & Subscription（认证与订阅）

Auth 子系统负责用户身份验证和订阅管理：

用户认证：提供用户注册、登录（支持 OAuth 第三方登录等）。API 网关在处理请求时会通过 Auth 模块验证客户端提供的令牌或 API 密钥是否合法，确定用户身份。

订阅计划：管理用户的订阅等级（例如免费、专业版等）和有效期。对于需要计费的 API 调用或高端模型访问，Auth 模块检查用户是否有相应权限或剩余额度。

访问控制：Auth 与 Usage Ledger 协同，可根据订阅策略限制用户的使用上限或调用频率。如免费用户超出额度则拒绝新任务或降级模型服务。

# Billing & Usage Ledger（计费与用量记录）

Billing/Usage 系统跟踪并记录每个用户的 AI 调用用量，以支持计费核算：

Usage Ledger（用量日志）：每当后端调用一次 LLM 模型，都将记录用户ID、模型类型、消耗的 Token 数量、推理时长及估算成本等数据。这个“账本”累积了用户使用服务的历史，用于统计费用及后续分析
javascript.plainenglish.io
。

计费策略：Billing 模块根据 Usage Ledger 的数据和用户订阅计划，周期性计算应收费金额或扣减预付代币。例如按月汇总 Token 使用量，超出订阅自带额度的部分按预定单价计费。也可以对接支付网关（如 Stripe）实现自动扣费和发票开具。

用量查询：提供 API 或管理界面供用户查询自己的使用统计（例如本月用了多少 Token、花费多少费用），提高服务透明度。

# 模型路由器（Model Router）

Model Router 模块负责对接多个大模型服务，并按任务阶段选择适当的模型：

多模型支持：genRTL 后端同时接入 OpenAI 的 GPT-5.1 模型和 Anthropic 的 Claude 模型。Model Router 内部封装两者的 API 调用方法、密钥和参数配置。

智能路由：根据任务性质决定调用哪种模型。设计上约定：Plan 阶段使用 GPT-5.1（擅长分析理解和规划任务），实现阶段使用 Claude（善于代码生成，支持更长上下文）
javascript.plainenglish.io
。Router 提供统一接口（例如 requestModel(service, prompt)），根据 service 参数选择对应模型并发送请求。

错误处理与降级：Router 处理模型 API 的异常情况，如超时或配额限制。必要时对调用进行重试，或策略性降级（例如 GPT-5.1 不可用时暂时改用次优模型），以提高流程健壮性。

Prompt 管理：调用前，Router 根据阶段组装 Prompt。例如 Plan 阶段提供 Spec 文本并要求模型输出结构化计划；Code 阶段提供 Plan 结果、相关模板代码和格式要求（输出 unified diff）。Router 也可以在必要时对模型输出做格式校验或简单清理，然后再返回给 Dispatcher 的步骤函数使用。

# CBB Registry（模板库）

CBB Registry 是用于存储和检索常用 RTL 模块模板的服务：

模板仓库：预先收录各类可复用的设计单元（如 FIFO 队列、ALU 运算单元、总线接口等），每个模板包含实现代码（Verilog/SystemVerilog）、参数化接口以及用途描述等元数据。

检索接口：提供根据关键词或功能描述搜索模板的 API。当 Plan 步骤输出的方案中涉及标准组件时，后端会调用 CBB Registry 查询匹配的模板。例如 Plan 识别需要一个 FIFO 队列模块，则 Dispatcher 在进入 Code 步骤前从 Registry 获取符合规格（如位宽、深度）且可实例化的 FIFO 模板代码片段。

模板实例化：Registry 不但提供代码，还支持模板实例化操作——对于带参数的模板，后端可指定参数值生成特定配置的代码实例。Code 步骤中的 Claude 模型在生成代码时，可直接利用这些模板代码，避免重复造轮子，提高代码正确性。

动态扩展：CBB 模板库可以由开发团队持续扩充，并通过标签、嵌入向量等方式实现更智能的检索。将来 Plan 模型也可参考此库（例如检索与当前 Spec 相似的设计范例）以优化输出。

# Job Dispatcher（任务调度器）

Job Dispatcher 是后端执行多步骤任务的核心，采用类似 Inngest 的事件驱动工作流引擎
javascript.plainenglish.io
：

事件触发：当 API 接收到用户提交的 Spec 请求后，会向 Dispatcher 发送一个事件（如 “DesignJobRequested”），包含任务 ID、用户 ID 和 Spec 内容等数据。Dispatcher 监听该事件并启动对应的工作流。

步骤编排：工作流定义为一系列函数步骤，每个步骤完成特定子任务。对于自动 RTL 任务，主要步骤包括：Plan 设计规划、（可选）模板检索、Code 代码生成，以及后续结果处理。Dispatcher 确保这些步骤按顺序执行，前一步的输出作为后一步的输入。

可靠执行：工作流各步骤在云端异步执行，互相解耦。若某步骤失败（例如模型调用超时），Inngest 框架会自动重试该步骤，并保留之前成功步骤的状态
javascript.plainenglish.io
。这意味着整个任务具备容错性，可在中断后从上次成功点恢复继续。

并发与限流：Dispatcher 可以控制任务并发数和速率限制。例如限制同一用户同时运行的任务数量，防止滥用。也记录每次任务的执行时间和结果状态，便于监控和调优。

任务类型扩展：除了 Spec→Code 完整流程，Dispatcher 还能管理其他类型的任务（如仅代码优化、错误分析等）。通过定义不同事件和步骤序列，即可扩展出不同的自动化流程。

# 任务处理流程

genRTL 后端从接受任务请求到返回结果，会经历一系列步骤。以下流程图描述了一次 Spec 任务在后端的处理与流转，以及计费记录的过程（genRTL 后端任务流）：

flowchart TD
    U[用户/客户端] -->|提交 Spec 请求| RAPI[后端 API 网关]
    RAPI -->|Auth 验证| AuthCheck{{订阅有效?}}
    AuthCheck -- 否 --> Deny[请求拒绝<br/>返回错误]
    AuthCheck -- 是 --> Trigger[触发 Inngest 工作流]
    Trigger --> PlanFn[步骤1: 调用 GPT-5.1 生成 Plan]
    PlanFn --> PlanOut[Plan 输出]
    PlanOut -->|检索模板| TemplateStep[步骤2: 查询 CBB 模板库]
    TemplateStep --> Templates[匹配到的模板代码]
    Templates --> CodeFn[步骤3: 调用 Claude 生成代码]
    PlanOut --> CodeFn
    CodeFn --> PatchResult[生成 Patch 补丁]
    PatchResult -->|记录 token 用量| UsageLog[Usage Ledger 写入]
    UsageLog --> BillingProc[计费处理]
    PatchResult --> Return[准备返回结果]
    Return -->|HTTP 响应 Patch| U

任务请求：用户在客户端发起 Spec 提交请求，由后端 API 接收。首先进行用户认证及订阅状态检查。如果未通过（如未登录或订阅无效），则拒绝请求并返回错误信息。
工作流触发：通过 Job Dispatcher（如 Inngest）创建一个异步任务工作流来处理该 Spec。这样即使流程较长也不会阻塞 HTTP 请求线程（可选择立即返回任务 ID，或由客户端轮询/回调获取结果）。

步骤1 – 生成 Plan：工作流第一步调用 GPT-5.1 模型，根据 Spec 生成实现计划。Prompt 中包含用户的规格描述，要求模型输出结构化的设计方案（例如模块列表、接口定义、验证思路等）。GPT-5.1 返回 Plan 结果，格式可以是条列要点或 JSON 结构，供后续步骤解析使用。

步骤2 – 模板检索：根据 Plan 内容，确定是否需要引入已有模板。如果 Plan 提到使用某些标准模块，则此步骤调用 CBB 模板库搜索匹配的实现，将得到的模板代码或参数提供给下一步。如 Plan 指明需要一个 FIFO 队列，则检索相应 FIFO 模板代码（如参数化的深度、位宽），准备给代码生成步骤参考。

步骤3 – 生成代码：调用 Claude 模型完成功能代码实现。Prompt 包括：Plan 细节、（可选）引入的模板代码片段，以及对输出格式的要求（例如使用 Unified Diff 输出代码改动）。Claude 利用其编程能力产出满足 Spec 的 RTL 代码，通常以 diff 补丁形式描述对各文件的修改和新增内容。生成结果暂存为 Patch 文本。

结果返回：当工作流完成后，后端将最终 Patch 结果通过 API 返回给客户端 Agent。客户端据此应用代码改动并进入本地验证环节。如果采用异步模式，API 可在任务完成时通过事件或轮询让客户端获取结果。

用量记录与计费：在模型调用完成后，后端记录此次任务中各模型调用的 Token 数量和成本到 Usage Ledger 中。例如 GPT-5.1 使用了 N 个 Token，Claude 使用了 M 个 Token，每条记录包含模型名称和对应费用。Billing 模块据此更新用户的使用量统计，按照计费周期汇总扣费或提示用户升级订阅。每次 AI 推理的详细用量都有据可查，支持后续账单结算和系统监控。
