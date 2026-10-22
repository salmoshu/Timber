// 渲染后 HTML 的安全收口（v0.5.9）：Markdown 内嵌 HTML 以 sanitize:false 放行渲染，
// 再在 DOM 上剥掉活跃元素（script/iframe 等）、on* 事件属性与 javascript: 协议链接——
// 本地文档虽可信，粘贴/同步来的内容仍可能夹带 XSS 载荷。
// 两函数均幂等，可在 MutationObserver 驱动的重复刷新中安全调用。

const DROP_TAGS = 'script,iframe,object,embed,form,meta,link,base'

/** 清洗已渲染容器：移除活跃元素与事件/危险协议属性 */
export function sanitizeRenderedHtml(root: ParentNode): void {
  root.querySelectorAll(DROP_TAGS).forEach((el) => el.remove())
  root.querySelectorAll<HTMLElement>('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name)
        continue
      }
      if (name === 'href' || name === 'src' || name === 'xlink:href') {
        const v = attr.value.replace(/\s/g, '').toLowerCase()
        if (v.startsWith('javascript:') || v.startsWith('vbscript:')) el.removeAttribute(attr.name)
        else if (v.startsWith('data:') && !v.startsWith('data:image/')) el.removeAttribute(attr.name)
      }
    }
  })
}

/** 段落内行内 HTML（Vditor WYSIWYG 渲染为 <code data-type="html-inline"> 的转义源码文本）：
 *  仅把「纯 <img> 标签」升级为真实图片（先消毒再替换，src 随后由 rewriteImages 重写），
 *  其余行内 HTML 维持源码展示不动 */
export function upgradeInlineHtml(root: ParentNode): void {
  root.querySelectorAll('code[data-type="html-inline"]').forEach((code) => {
    // textContent 可能带 Vditor 光标占位的零宽字符（​ 等），先剥掉再匹配
    const text = (code.textContent ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
    if (!/^<img\s[^>]*\/?>$/is.test(text)) return
    const tpl = document.createElement('template')
    tpl.innerHTML = text
    const img = tpl.content.querySelector('img')
    if (!img) return
    sanitizeRenderedHtml(tpl.content)
    img.setAttribute('data-an-inline-html', '1')
    code.replaceWith(img)
  })
}
