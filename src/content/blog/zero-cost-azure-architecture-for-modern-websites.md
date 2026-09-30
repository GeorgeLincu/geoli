---
title: "Zero-Cost Azure Architecture for Modern Websites"
description: "Architect secure, globally distributed websites on free tiers with Azure Static Web Apps, serverless Functions and Cloudflare: limits, headers, CSP and caching."
pubDate: 2026-10-15
tags: ["Azure"]
draft: true
---

Personal sites, portfolios, documentation and small business websites rarely need a server running around the clock. With static site generation, serverless functions and a global edge network, you can build something fast, secure and resilient for little or no hosting cost. This article walks through a practical free-tier architecture using Azure Static Web Apps, serverless Azure Functions and Cloudflare, compares Azure with Cloudflare's own static hosting, and is honest about where the free tiers stop.

## What "Zero-Cost" Really Means

"Zero-cost" here means no recurring hosting charges for a typical low-to-moderate traffic site. It does not mean zero cost in every scenario. There are a few things to keep in mind:

- **Domain registration** is almost never free.
- **Free tiers have limits** on bandwidth, requests, storage, custom domains and features, and exceeding them may mean throttling, errors or a required upgrade.
- **Free tiers usually have no SLA.** That is acceptable for a portfolio, less so for a revenue-generating site.
- **Terms change.** Providers adjust free allowances over time, so always confirm the current figures in the official documentation before committing.

With those caveats, a well-designed static site can comfortably run on free plans for a long time.

## The Architecture at a Glance

The pattern has three layers:

1. **Static front end**: HTML, CSS, JavaScript and assets generated at build time by a framework such as Astro, Hugo, Next.js (static export) or Eleventy.
2. **Serverless API**: small functions for the few things that need server-side logic, such as a contact form, a newsletter sign-up or a token exchange.
3. **Edge and DNS**: a CDN and DNS provider that handles TLS, caching, security headers and protection against abusive traffic.

Deployment is driven from a Git repository. Every push to the main branch builds and publishes the site, and pull requests can produce preview environments.

## Azure Static Web Apps: Free Tier in Practice

[Azure Static Web Apps](https://learn.microsoft.com/azure/static-web-apps/) is purpose-built for this pattern. It connects to GitHub or Azure DevOps, builds your site with a generated workflow, and serves static content from a globally distributed network.

At the time of writing, the Free plan includes, in broad terms:

- Free, automatically managed TLS certificates.
- A small number of custom domains per app (Microsoft has documented two on Free).
- A limited number of staging (preview) environments for pull requests.
- A monthly bandwidth allowance (documented as 100 GB per subscription).
- An app size limit in the low hundreds of megabytes.
- Integrated **managed Functions** for an API.
- Built-in authentication with pre-configured providers.

Features such as bringing your own existing Functions app, custom authentication providers, private endpoints and an SLA are reserved for the Standard plan. Check the current [plan comparison on Microsoft Learn](https://learn.microsoft.com/azure/static-web-apps/) before relying on any specific number.

### Configuring headers and routes

Static Web Apps is configured with a `staticwebapp.config.json` file in your build output or app location. You can set global security headers there:

```json
{
  "globalHeaders": {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'"
  },
  "responseOverrides": {
    "404": { "rewrite": "/404.html" }
  }
}
```

## Serverless Functions for Dynamic Features

Managed Functions in Static Web Apps are ideal for lightweight API calls. They are exposed under `/api`, share the site's domain (so no CORS configuration is needed) and are deployed alongside the front end. They support HTTP triggers only; for timers, queues or other triggers you need a separate Azure Functions app, which on Static Web Apps means the Standard plan if you want to link it.

If you run a standalone Functions app, the consumption-based hosting plans include a monthly free grant of executions and compute time. Microsoft has been moving customers towards the Flex Consumption plan, so review the current [Azure Functions hosting documentation](https://learn.microsoft.com/azure/azure-functions/) for the plan that suits new projects and its free allowance.

A few design tips keep functions cheap and safe:

- Keep them small and stateless, and avoid long-running work.
- Store secrets in application settings or Azure Key Vault, never in the repository.
- Validate and rate-limit input. For forms, a challenge such as Cloudflare Turnstile helps keep automated spam out.
- Expect occasional cold starts on consumption plans and design the user experience accordingly.

## Adding Cloudflare as the Edge Layer

Cloudflare's free plan adds a useful layer in front of almost any origin, including Azure Static Web Apps:

- Authoritative DNS with fast propagation.
- Universal TLS at the edge.
- DDoS mitigation and basic bot and firewall rules.
- CDN caching with configurable cache rules.
- Transform rules for adding or changing response headers.

### Watch out for double proxying

Placing Cloudflare's proxy in front of Static Web Apps is possible, but there are details to get right:

- **Domain validation**: Static Web Apps needs to validate your custom domain. It is often simplest to leave the Cloudflare record as DNS-only while validation and certificate issuance complete, then enable the proxy.
- **TLS mode**: use Cloudflare's **Full (strict)** SSL/TLS mode so traffic is encrypted and validated end to end.
- **Caching layers**: both Azure and Cloudflare may cache content. Set sensible `Cache-Control` headers at the origin, and purge the Cloudflare cache after deployments if you cache HTML.
- **Headers in two places**: decide whether security headers are set at the origin or at the edge, to avoid conflicting values.

## Azure Static Web Apps vs Cloudflare Workers and Pages

For a purely static site, you may not need Azure at all. Cloudflare offers [static assets on Workers](https://developers.cloudflare.com/workers/) and [Cloudflare Pages](https://developers.cloudflare.com/pages/). Cloudflare now positions Workers with static assets as the recommended path for new projects, though Pages remains supported.

| Consideration | Azure Static Web Apps (Free) | Cloudflare Workers static assets / Pages (Free) |
| --- | --- | --- |
| Static hosting | Yes, globally distributed | Yes, served from Cloudflare's edge network |
| Bandwidth | Monthly allowance per subscription | Static asset requests are not billed on Workers; check current terms |
| Server-side logic | Managed Functions (HTTP) | Workers, subject to a daily request limit on the free plan |
| Custom domains | Limited number per app | Generous, but domain typically managed in Cloudflare |
| Headers | `staticwebapp.config.json` | `_headers` file |
| File limits | App size limit | Limits on file count and individual file size |
| Best fit | Teams already invested in Azure, Entra ID or Azure DevOps | Sites wanting everything at the edge in one provider |

On Cloudflare, security headers for static assets are defined in a `_headers` file in the output directory:

```text
/*
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: default-src 'self'; img-src 'self' data:; frame-ancestors 'none'
```

In my view, the choice comes down to where the rest of your ecosystem lives. If you need Entra ID authentication or want your API next to other Azure resources, Static Web Apps is a natural fit. If the site is standalone, keeping hosting, DNS and edge logic in one place reduces moving parts.

## Security Essentials on a Free Budget

A zero-cost site can still be well secured.

### Content Security Policy

A Content Security Policy (CSP) is the most effective header for reducing cross-site scripting risk. Start strict, with `default-src 'self'`, and add only the sources you genuinely need. Self-hosting fonts and scripts makes this far easier, because every third-party domain you load from must be explicitly allowed. Test with `Content-Security-Policy-Report-Only` before enforcing.

### Other headers and hygiene

- **HSTS** forces HTTPS. Only add `preload` once you are certain every subdomain supports HTTPS.
- **X-Content-Type-Options: nosniff** and a sensible **Referrer-Policy** are low-risk defaults.
- **Permissions-Policy** disables browser features you do not use.
- Make sure repository files, source maps you do not intend to publish and configuration files are excluded from the deployed output.

You can check your headers with a free tool such as Mozilla's HTTP Observatory.

## CDN Caching Strategy

Caching is where performance and cost savings come together:

- **Fingerprinted assets** (for example `app.3f9a1c.js`) can be cached for a year with `Cache-Control: public, max-age=31536000, immutable`.
- **HTML** should use a short cache time or revalidation, so new deployments appear promptly.
- **API responses** should normally not be cached at the edge unless they are genuinely public and static.

## Free-Tier Architecture Checklist

- [ ] Static site generated at build time from a Git repository
- [ ] Hosting plan limits checked against expected traffic and site size
- [ ] Custom domain with managed TLS and Full (strict) mode if proxied
- [ ] Security headers and a tested Content Security Policy
- [ ] Serverless functions small, validated and protected against spam
- [ ] Secrets stored in app settings or a vault, not the repository
- [ ] Cache headers set for assets, HTML and API responses
- [ ] Budget or usage alerts configured where the provider supports them

## Key Takeaways

- Static front ends plus serverless functions and an edge network deliver fast, resilient sites with little or no hosting cost.
- Azure Static Web Apps Free is a strong option, but know its limits on bandwidth, domains, app size and features, and remember there is no SLA.
- Cloudflare works well as an edge layer in front of Azure, or as a complete alternative with Workers static assets or Pages.
- Security headers, a strict CSP and careful caching cost nothing and make a significant difference.
- Free-tier terms change, so verify current limits in the official documentation before you build.
