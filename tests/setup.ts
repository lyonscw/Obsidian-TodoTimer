// jsdom does not implement the geometry APIs used by CodeMirror's measurement pass.
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
HTMLElement.prototype.scrollIntoView ??= () => undefined;
