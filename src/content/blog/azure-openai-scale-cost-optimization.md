---
title: "Azure OpenAI at Scale: Real-World Cost Optimization"
description: "How to manage Azure OpenAI costs when you have multiple agents and high usage. Smart quotas, model selection, and the tactics that actually work."
pubDate: 2026-10-08
tags: ["Azure", "Cost Optimization", "AI"]
draft: true
---

A customer called with a problem. They'd built a Copilot Studio agent three months ago. It was generating real value—handling vendor inquiries, reducing support ticket volume. Then they looked at the bill.

Azure OpenAI: $47,000 that month. Previous month: $34,000. The trend was unsustainable.

Nobody had set guardrails. No quotas, no alerts, no visibility into what was driving the spike. The agent was running more queries than expected, and with no checks, costs just climbed.

This is more common than you'd think, and it's entirely solvable. The patterns are straightforward; the discipline to implement them is where most teams stumble.

## The Cost Drivers You Actually Control

Azure OpenAI bills on tokens—input tokens and output tokens separately. The math is simple: more requests, longer prompts, longer responses, higher bills. What varies is how much each of those you actually need.

### Request Volume

The obvious one: how many API calls per day. If your Copilot Studio agent is running in Teams for 500 users, and each user averages five interactions per day, that's 2,500 calls per day. Straightforward multiplication to estimate costs.

The problem: usage varies. A quiet Tuesday is 1,500 calls. A crisis Tuesday where everyone's asking for status updates is 8,000 calls. And you might not know that until the bill comes.

**What to do**: Instrument and alert. Track API calls by hour, by user, by feature. Set a daily budget alert in Azure Monitor. When you hit 70% of your daily burn rate by noon, you get paged. You can't optimize what you don't see.

### Input Token Length

Every request to the API includes a prompt. The prompt includes:
- The system instruction (usually a few hundred tokens)
- The conversation history (could be a few tokens, could be thousands)
- The actual user message
- Retrieved context (if you're using RAG)

For a Copilot Studio agent retrieving documents from SharePoint, the retrieved context can be massive. I've seen Copilot Studio agents pull 10,000 tokens of context from a knowledge source just to answer "what's my PTO balance?"

Input tokens cost 1.5 to 3x less than output tokens (depending on the model), but they add up fast.

**What to do**: Be ruthless about context. In Copilot Studio, limit the number of documents retrieved (set `Search Results` to 3, not 10). Summarize long documents before sending them to the model. If you're using Azure OpenAI directly, truncate conversation history—you don't need the entire six-month chat; last few turns matter. Use `max_tokens` on the request to limit response length.

### Output Token Length

Some models are verbose by default. GPT-4 is more thoughtful and longer. If you need faster, shorter responses, GPT-3.5-turbo produces tighter output.

More importantly: do you actually need long responses? A customer service agent saying "Your order shipped on Oct 2 and will arrive Oct 8. Track it here [link]" is perfect. 40 tokens. Asking the same agent "Write a detailed explanation of why your order hasn't arrived yet and what we're doing about it and please be thorough" might get you 300 tokens and doesn't help the customer faster.

**What to do**: Tune system instructions to encourage brevity. "Be concise. Answers should be 1-3 sentences unless the user asks for more detail." Test your agent and measure the average response length. If it's creeping up, investigate why.

### Model Selection

The price list:
- **GPT-4-turbo** (~$0.01 per 1k input tokens, $0.03 per 1k output): High quality, thoughtful, slow.
- **GPT-4** (newer versions are cheaper): Similar quality to GPT-4-turbo, better performance.
- **GPT-3.5-turbo** (~$0.0005 per 1k input tokens, $0.0015 per 1k output): Fast, good enough for many tasks, 20x cheaper.

If your agent is answering FAQ questions from a knowledge base, GPT-3.5-turbo is likely fine. If it's generating technical documentation or handling nuanced business decisions, you might need GPT-4.

**What to do**: Test both models against your actual use cases. Run 100 real queries through GPT-3.5-turbo and GPT-4, and compare quality and cost. Measure what matters: user satisfaction, accuracy, response time. You'll often find GPT-3.5-turbo is "good enough" and saves 75% on costs.

## The Tiering Strategy

Here's a pattern that works for organisations with multiple agents:

**Tier 1 (High-volume, low-stakes):** FAQ bot, internal documentation lookup, simple status checks. Use GPT-3.5-turbo. Cache the system prompt if your platform supports it (newer Azure OpenAI versions do). Quota: $5,000/month per agent.

**Tier 2 (Medium-volume, medium-stakes):** Vendor inquiry agent, expense report classification. Use GPT-4. More care with prompts. Quota: $15,000/month per agent.

**Tier 3 (Low-volume, high-stakes):** Legal review agent, contract analysis, approval decisions. Use GPT-4-turbo or even o1 for critical decisions. These queries might be 100+ tokens each, but volume is low. Quota: $20,000/month per agent.

Assign each agent to a tier. Monitor each tier separately. When an agent approaches its quota, page the owner. They either optimize or get budget approval from management.

This structure lets you scale without surprises.

## Prompt Caching and Tokens

Azure OpenAI now supports prompt caching: if you send the same long context (like a 50-page document) multiple times, the service caches it and charges less for repeat usage.

**How it works**: First query with document = full cost. Second query with same document = ~10% of the cost for the repeated tokens.

**What to do**: If you have knowledge sources that don't change often (product documentation, policy handbook), use prompt caching. Set `cache_control: "ephemeral"` on the system prompt. Your costs drop 20-30% if usage is repetitive.

## Rate Limiting and Quotas in Practice

Here's the implementation:

**In Copilot Studio**: You can't set hard quotas directly, but you can:
- Limit the max requests per conversation
- Add delays between requests
- Escalate to human if the conversation gets too long

**In Azure OpenAI directly**: Use Azure's rate limiting (quotas per minute/hour/day). Set a hard limit: if an app is using more than X tokens per minute, throttle it.

**In Power Automate**: Add a check before each API call. If the daily cost is trending over budget, skip the call and log it. Notify the owner.

**In infrastructure**: Use API Management or a proxy layer to enforce quotas. It's more work upfront but gives you total visibility.

## Real Example: Three Agents, $200k Budget

An enterprise has three Copilot Studio agents:

- **Agent A (FAQ)**: 5,000 users, 3 queries/user/day = 15,000 queries/day. GPT-3.5-turbo. Target: $4,000/month. Budget alert: $5,600 (80%).
- **Agent B (Vendor Inquiry)**: 200 users, 5 queries/user/day = 1,000 queries/day. GPT-4. Target: $12,000/month. Budget alert: $16,800 (80%).
- **Agent C (Approvals)**: 50 users, 1 query/user/day = 50 queries/day. GPT-4-turbo. Target: $8,000/month. Budget alert: $11,200 (80%).

Total budget: $24,000/month. With alerts and quotas, actual costs track within 5% of forecast.

Without guardrails? Any of these agents could spike to $50,000/month if usage doubles and nobody notices.

## The Mistakes That Cost the Most

**1. Upgrading models without re-testing**

You build with GPT-3.5-turbo, it's working well. Someone sees that GPT-4 is "better" and switches the agent. Costs quadruple, quality improves 10%. Not worth it. Measure the cost-benefit.

**2. Not truncating conversation history**

A chatbot that keeps the entire six-month conversation history costs 5x more than one that keeps just the last 10 turns. The old messages don't help the model decide what to say next. Truncate.

**3. Not setting alerts**

By the time you see the bill, the damage is done. You've spent $100k instead of $20k. Set Azure Monitor alerts for daily spending, for API quota consumption, for request rates. Don't wait for the bill.

**4. Caching when you shouldn't**

Not every prompt benefits from caching. If your context changes every query, caching adds latency without saving costs. Use caching for truly static knowledge bases, not for per-request queries.

**5. Ignoring cheaper alternatives**

Sometimes you don't need Azure OpenAI. Sometimes a simple rule set or a regex pattern solves the problem cheaper. Not everything needs an LLM. Evaluate whether you actually benefit from the cost.

## The Process That Works

1. **Measure**: Instrument every agent. Track daily costs, token usage, query volume.
2. **Alert**: Set budget alerts at 70%, 85%, 95% of expected spend.
3. **Review**: Weekly, check your top 5 most expensive queries. Are they necessary? Can they be optimized?
4. **Optimize**: Trim context, test model downgrades, check for unusual patterns.
5. **Repeat**: This is continuous. Costs creep up if you're not actively managing them.

The teams that succeed do this methodically. They don't build an agent and forget about it. They monitor, they alert, they optimize.

Your costs shouldn't surprise you. If they do, you're not measuring enough.
