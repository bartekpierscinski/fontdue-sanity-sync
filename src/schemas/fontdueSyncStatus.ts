import { defineField, defineType } from "sanity";

const statsFields = (group: string) => [
  defineField({
    name: "created",
    title: "Created",
    type: "number",
  }),
  defineField({
    name: "updated",
    title: "Updated",
    type: "number",
  }),
  defineField({
    name: "deleted",
    title: "Deleted",
    type: "number",
  }),
  defineField({
    name: "skippedUnchanged",
    title: "Skipped (unchanged)",
    type: "number",
  }),
];

export function createFontdueSyncStatus() {
  return defineType({
    name: "fontdueSyncStatus",
    title: "Fontdue Sync Status",
    type: "document",
    readOnly: true,
    fields: [
      defineField({
        name: "lastSync",
        title: "Last Sync",
        type: "datetime",
      }),
      defineField({
        name: "status",
        title: "Status",
        type: "string",
        options: {
          list: [
            { title: "Success", value: "success" },
            { title: "Failed", value: "failed" },
          ],
        },
      }),
      defineField({
        name: "triggeredBy",
        title: "Triggered By",
        type: "string",
        options: {
          list: [
            { title: "Manual", value: "manual" },
            { title: "Webhook", value: "webhook" },
            { title: "Cron", value: "cron" },
          ],
        },
      }),
      defineField({
        name: "durationMs",
        title: "Duration (ms)",
        type: "number",
      }),
      defineField({
        name: "collections",
        title: "Collections",
        type: "object",
        fields: statsFields("collections"),
      }),
      defineField({
        name: "styles",
        title: "Styles",
        type: "object",
        fields: statsFields("styles"),
      }),
      defineField({
        name: "licenses",
        title: "Licenses",
        type: "object",
        fields: statsFields("licenses"),
      }),
      defineField({
        name: "errorMessage",
        title: "Error Message",
        type: "text",
      }),
    ],
    preview: {
      select: {
        lastSync: "lastSync",
        status: "status",
      },
      prepare({ lastSync, status }) {
        return {
          title: "Fontdue Sync Status",
          subtitle: lastSync
            ? `${status} — ${new Date(lastSync).toLocaleString()}`
            : "No sync recorded",
        };
      },
    },
  });
}
