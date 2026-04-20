import { defineField, defineType } from "sanity";
import type { SchemaOptions } from "./types.js";

export function createFontdueCollection(options?: SchemaOptions) {
  const includeParentRef = options?.includeParentRef === true;
  const includeUpdatedAt = options?.includeUpdatedAt === true;
  const includeFeatureStyleRef = options?.includeFeatureStyleRef === true;
  const collectionIcon = options?.icons?.collection;
  const superfamilyIcon = options?.icons?.superfamily;

  const fields = [
    defineField({
      name: "fontdueId",
      title: "Fontdue ID",
      type: "string",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "name",
      title: "Name",
      type: "string",
    }),
    defineField({
      name: "slug",
      title: "Slug",
      type: "string",
    }),
    defineField({
      name: "collectionType",
      title: "Collection Type",
      type: "string",
      options: {
        list: [
          { title: "Family", value: "family" },
          { title: "Superfamily", value: "superfamily" },
        ],
      },
    }),
    ...(includeParentRef
      ? [
          defineField({
            name: "parent",
            title: "Parent Collection",
            type: "reference",
            to: [{ type: "fontdueCollection" }],
            description:
              "Superfamily parent (for families that are part of a superfamily)",
          }),
        ]
      : []),
    defineField({
      name: "children",
      title: "Child Collections",
      description: includeParentRef
        ? "Families within this superfamily (computed reverse reference)"
        : "Families within this superfamily",
      type: "array",
      of: [{ type: "reference", to: [{ type: "fontdueCollection" }] }],
      hidden: ({ document }) => document?.collectionType !== "superfamily",
    }),
    defineField({
      name: "styles",
      title: "Styles",
      description: "Font styles in this family",
      type: "array",
      of: [{ type: "reference", to: [{ type: "fontdueStyle" }] }],
      hidden: ({ document }) => document?.collectionType !== "family",
    }),
    ...(includeUpdatedAt
      ? [
          defineField({
            name: "updatedAt",
            title: "Updated At",
            type: "datetime",
            hidden: true,
          }),
        ]
      : []),
    ...(includeFeatureStyleRef
      ? [
          defineField({
            name: "featureStyle",
            title: "Feature Style",
            description:
              "The style shown as the family's representative, synced from Fontdue.",
            type: "reference",
            to: [{ type: "fontdueStyle" }],
            readOnly: true,
            hidden: true,
          }),
        ]
      : []),
  ];

  return defineType({
    name: "fontdueCollection",
    title: "Font",
    type: "document",
    readOnly: true,
    fields,
    preview: {
      select: {
        title: "name",
        collectionType: "collectionType",
        ...(includeParentRef ? { parentName: "parent.name" } : {}),
      },
      prepare(selection) {
        const { title, collectionType } = selection;
        const parentName =
          "parentName" in selection ? selection.parentName : undefined;

        let subtitle = collectionType;
        if (parentName) {
          subtitle = `${collectionType} in ${parentName}`;
        }

        const icon =
          collectionType === "superfamily" ? superfamilyIcon : collectionIcon;

        return {
          title,
          subtitle,
          ...(icon ? { media: icon } : {}),
        };
      },
    },
  });
}
