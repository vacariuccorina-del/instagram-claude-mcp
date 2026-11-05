import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { InstagramClient } from "./instagram/client.js";
import { InstagramApiError } from "./instagram/client.js";


function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          data,
          (key, value) => {
            if (key === "paging" && value && typeof value === "object") {
              const { next, previous, ...safePaging } = value;
              return safePaging;
            }
            return value;
          },
          2,
        ),
      },
    ],
  };
}


function errorResult(error: unknown) {
  const status =
    error instanceof InstagramApiError ? error.status : undefined;

  const safeError = {
    error: "Instagram API request failed",
    ...(status !== undefined ? { status } : {}),
  };

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(safeError, null, 2),
      },
    ],
    isError: true,
  };
}

export function createInstagramMcpServer(client: InstagramClient): McpServer {
  const server = new McpServer({
    name: "instagram-claude-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "get_instagram_profile",
    {
      description:
        "Get the connected Instagram professional account profile (username, follower counts, etc.). For Instagram Login this uses GET /me and resolves user_id automatically. Read-only.",
      inputSchema: z.object({
        fields: z
          .string()
          .optional()
          .describe(
            "Optional comma-separated Graph API fields. Defaults to common profile fields.",
          ),
      }),
    },
    async ({ fields }) => {
      try {
        const profile = await client.getProfile(fields);
        return jsonResult(profile);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "list_instagram_media",
    {
      description:
        "List recent Instagram media for the connected professional account (posts, reels, carousels). Uses the Instagram Login IG user_id from /me for /{user_id}/media. Read-only.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Number of media items to return (1-100). Default is API default."),
        after: z
          .string()
          .optional()
          .describe("Pagination cursor from a previous response (paging.cursors.after)."),
        fields: z
          .string()
          .optional()
          .describe("Optional comma-separated Graph API fields for each media item."),
      }),
    },
    async ({ limit, after, fields }) => {
      try {
        const media = await client.listMedia({ limit, after, fields });
        return jsonResult(media);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_instagram_media",
    {
      description:
        "Get details for a specific Instagram media item by ID (caption, type, URLs, engagement counts). Read-only.",
      inputSchema: z.object({
        media_id: z.string().describe("Instagram media ID."),
        fields: z
          .string()
          .optional()
          .describe("Optional comma-separated Graph API fields."),
      }),
    },
    async ({ media_id, fields }) => {
      try {
        const media = await client.getMedia(media_id, fields);
        return jsonResult(media);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_instagram_insights",
    {
      description:
        "Read Instagram insights/analytics. Use scope=account for account-level metrics, or scope=media with media_id for media-level metrics. Read-only.",
      inputSchema: z.object({
        scope: z
          .enum(["account", "media"])
          .describe("Whether to fetch account-level or media-level insights."),
        metrics: z
          .string()
          .describe(
            "Comma-separated metric names required by the Instagram Insights API (e.g. reach,views,likes,comments,total_interactions).",
          ),
        media_id: z
          .string()
          .optional()
          .describe("Required when scope=media. Instagram media ID."),
        period: z
          .string()
          .optional()
          .describe(
            "Time period when required by the metric (e.g. day, week, days_28, lifetime, or timeframe-based metrics).",
          ),
        metric_type: z
          .string()
          .optional()
          .describe("Account insights metric_type when needed (e.g. total_value, time_series)."),
        timeframe: z
          .string()
          .optional()
          .describe("Account insights timeframe when needed (e.g. last_14_days, last_30_days, this_month)."),
        breakdown: z
          .string()
          .optional()
          .describe("Optional breakdown dimension (e.g. media_product_type, follow_type)."),
        since: z
          .string()
          .optional()
          .describe("Optional Unix timestamp start for account insights."),
        until: z
          .string()
          .optional()
          .describe("Optional Unix timestamp end for account insights."),
      }),
    },
    async (args) => {
      try {
        if (args.scope === "media") {
          if (!args.media_id) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "media_id is required when scope is media",
                },
              ],
              isError: true,
            };
          }

          const insights = await client.getMediaInsights(args.media_id, {
            metrics: args.metrics,
            period: args.period,
            breakdown: args.breakdown,
          });
          return jsonResult(insights);
        }

        const insights = await client.getAccountInsights({
          metrics: args.metrics,
          period: args.period,
          metricType: args.metric_type,
          timeframe: args.timeframe,
          breakdown: args.breakdown,
          since: args.since,
          until: args.until,
        });
        return jsonResult(insights);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_instagram_comments",
    {
      description:
        "Read comments on a specific Instagram media item (including nested replies when available). Read-only; does not post or reply.",
      inputSchema: z.object({
        media_id: z.string().describe("Instagram media ID."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Number of comments to return (1-100)."),
        after: z
          .string()
          .optional()
          .describe("Pagination cursor from a previous response."),
        fields: z
          .string()
          .optional()
          .describe("Optional comma-separated Graph API fields for comments."),
      }),
    },
    async ({ media_id, limit, after, fields }) => {
      try {
        const comments = await client.getComments(media_id, {
          limit,
          after,
          fields,
        });
        return jsonResult(comments);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}
