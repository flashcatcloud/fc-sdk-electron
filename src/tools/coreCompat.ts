// Compatibility shims for utility types that exist inside the FlashCat
// `@flashcatcloud/browser-core` fork but are not re-exported from its public
// entry point. They are reproduced here so the SDK only depends on the fork's
// public API surface (rather than reaching into private `cjs/tools/*` paths).

/**
 * Recursively makes every property of `T` optional. Mirrors
 * `@datadog/browser-core`'s `RecursivePartial`.
 */
export type RecursivePartial<T> = {
  [P in keyof T]?: T[P] extends (infer U)[]
    ? RecursivePartial<U>[]
    : T[P] extends object
      ? RecursivePartial<T[P]>
      : T[P];
};
