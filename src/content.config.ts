import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

// Blog posts: src/content/blog/<slug>.md  (set draft: false to publish)
const blog = defineCollection({
  loader: glob({ pattern: '**/[^_]*.md', base: './src/content/blog' }),
  schema: z.object({
    title:       z.string(),
    description: z.string().max(170),
    pubDate:     z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    tags:        z.array(z.string()).default([]),
    draft:       z.boolean().default(false),
  }),
});

// Case studies: src/content/projects/<slug>.md  (see _template.md)
const projects = defineCollection({
  loader: glob({ pattern: '**/[^_]*.md', base: './src/content/projects' }),
  schema: z.object({
    title:    z.string(),
    client:   z.string(),            // e.g. "European insurer" — anonymise if needed
    problem:  z.string(),
    approach: z.string(),
    outcome:  z.string(),
    tags:     z.array(z.string()).default([]),
    order:    z.number().default(100),
    draft:    z.boolean().default(false),
  }),
});

export const collections = { blog, projects };
