function documentFrom(value) {
  return value && typeof value.createElement === 'function' ? value : globalThis.document;
}

function isNode(value) {
  return value !== null
    && typeof value === 'object'
    && (typeof value.nodeType === 'number'
      || (value.ownerDocument !== null
        && typeof value.ownerDocument === 'object'
        && typeof value.ownerDocument.createElement === 'function'
        && typeof value.appendChild === 'function'));
}

/** Set visible text without interpreting markup. */
export function textContent(node, value) {
  if (arguments.length === 1 && !isNode(node)) return String(node ?? '');
  if (!isNode(node)) throw new TypeError('textContent target must be a DOM node');
  node.textContent = value == null ? '' : String(value);
  return node;
}

/** Set one attribute, omitting nullish and false values. */
export function setAttribute(node, name, value) {
  if (!node || typeof node.setAttribute !== 'function') {
    throw new TypeError('setAttribute target must be an element');
  }
  const attributeName = String(name);
  if (/^on/i.test(attributeName) || attributeName.toLowerCase() === 'srcdoc') {
    throw new TypeError(`unsafe attribute: ${attributeName}`);
  }
  if (value === null || value === undefined || value === false) return node;
  node.setAttribute(attributeName, value === true ? '' : String(value));
  return node;
}

export function clearChildren(node) {
  if (!node) return;
  if (typeof node.replaceChildren === 'function') node.replaceChildren();
  else while (node.firstChild) node.removeChild(node.firstChild);
}

function appendChild(documentRef, parent, child) {
  if (child === null || child === undefined || child === false) return;
  if (isNode(child)) {
    parent.appendChild(child);
    return;
  }
  if (Array.isArray(child)) {
    for (const nested of child) appendChild(documentRef, parent, nested);
    return;
  }
  parent.appendChild(documentRef.createTextNode(String(child)));
}

/**
 * Create an element from safe attributes and text/node children.
 * Supports createElement(tag, attrs, children, document) and
 * createElement(document, tag, attrs, children) for dependency-free tests.
 */
export function createElement(tagName, attributes = {}, children = [], documentRef = globalThis.document) {
  if (typeof tagName !== 'string') {
    documentRef = tagName;
    tagName = attributes;
    attributes = children;
    children = arguments[3] ?? [];
  }
  const ownerDocument = documentFrom(documentRef);
  if (!ownerDocument || typeof ownerDocument.createElement !== 'function') {
    throw new TypeError('a document with createElement is required');
  }
  if (typeof tagName !== 'string' || tagName.trim() === '') {
    throw new TypeError('tagName must be a non-empty string');
  }
  const element = ownerDocument.createElement(tagName);
  for (const [name, value] of Object.entries(attributes ?? {})) {
    setAttribute(element, name, value);
  }
  for (const child of (Array.isArray(children) ? children : [children])) {
    appendChild(ownerDocument, element, child);
  }
  return element;
}
