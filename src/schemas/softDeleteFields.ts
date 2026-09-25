import { defineField } from "sanity";

/**
 * The two fields `orphanStrategy: "softDelete"` writes on a collection or
 * pack that has left Fontdue while something in the dataset still references
 * it. A document that reappears in Fontdue is rewritten without them.
 */
export function softDeleteFields() {
  return [
    defineField({
      name: "isDeleted",
      title: "Removed from Fontdue",
      type: "boolean",
      readOnly: true,
      description:
        "Set when the document has left Fontdue (deleted or hidden) but is still referenced here. Cleared automatically when it comes back.",
    }),
    defineField({
      name: "deletedAt",
      title: "Removed at",
      type: "datetime",
      readOnly: true,
    }),
  ];
}
