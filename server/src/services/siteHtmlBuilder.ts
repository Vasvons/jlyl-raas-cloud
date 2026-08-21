/**
 * 灵犀站点引擎 — 站点 HTML 唯一生成源（SITE_ENGINE_PLAN P1）
 *
 * 自桌面端 services/publishService.ts 移植 generateBlockHtml / generateHtml / escapeHtml，
 * 成为站点的唯一 HTML 生成逻辑，保证发布(OSS)与预览(/sites/:id/preview)同源、不漂移。
 *
 * 区块类型（BlockType）：hero / features / pricing / faq / testimonials / cta / footer
 * 与桌面端 components/Editor/types.ts 保持一致，后续 P2 扩充区块类型时需同步。
 */

export type SiteBlock = {
  id?: string;
  type: string;
  props: Record<string, any>;
  order: number;
};

function escapeHtml(text: any): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function generateBlockHtml(block: SiteBlock): string {
  const p = block.props || {};
  switch (block.type) {
    case 'hero':
      return `
    <section style="background-color:${p.backgroundColor || '#3B82F6'};color:${p.textColor || '#FFFFFF'};padding:${p.padding || 80}px 24px;text-align:${p.alignment || 'center'}${p.backgroundImage ? `;background-image:url(${p.backgroundImage});background-size:cover;background-position:center` : ''}">
      <div style="max-width:800px;margin:0 auto">
        <h1 style="color:${p.textColor || '#FFFFFF'};font-size:42px;font-weight:700;margin-bottom:16px">${escapeHtml(p.title)}</h1>
        <p style="color:${p.textColor || '#FFFFFF'};font-size:18px;margin-bottom:32px;opacity:0.9">${escapeHtml(p.subtitle)}</p>
        <a href="${p.ctaLink || '#'}" style="display:inline-block;padding:12px 32px;background:${p.textColor === '#FFFFFF' ? '#FFFFFF' : '#1677ff'};color:${p.textColor === '#FFFFFF' ? (p.backgroundColor || '#3B82F6') : '#FFFFFF'};text-decoration:none;border-radius:8px;font-size:16px;font-weight:600">${escapeHtml(p.ctaText)}</a>
      </div>
    </section>`;

    case 'features': {
      const features = p.features || [];
      const cols = p.columns || 3;
      return `
    <section style="background-color:${p.backgroundColor || '#F9FAFB'};color:${p.textColor || '#1F2937'};padding:${p.padding || 60}px 24px;text-align:center">
      <div style="max-width:960px;margin:0 auto">
        <h2 style="color:${p.textColor || '#1F2937'};margin-bottom:48px;font-size:28px">${escapeHtml(p.title)}</h2>
        <div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:24px">
          ${features.map((f: any) => `
          <div style="text-align:center;padding:24px;border:1px solid #E5E7EB;border-radius:12px">
            <div style="width:56px;height:56px;border-radius:12px;background:#EFF6FF;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:24px">⭐</div>
            <h4 style="color:${p.textColor || '#1F2937'};font-size:18px;margin-bottom:8px">${escapeHtml(f.title)}</h4>
            <p style="color:#6B7280;font-size:14px">${escapeHtml(f.description)}</p>
          </div>`).join('')}
        </div>
      </div>
    </section>`;
    }

    case 'pricing': {
      const plans = p.plans || [];
      return `
    <section style="background-color:${p.backgroundColor || '#FFFFFF'};color:${p.textColor || '#1F2937'};padding:${p.padding || 60}px 24px;text-align:center">
      <div style="max-width:960px;margin:0 auto">
        <h2 style="color:${p.textColor || '#1F2937'};margin-bottom:48px;font-size:28px">${escapeHtml(p.title)}</h2>
        <div style="display:grid;grid-template-columns:repeat(${Math.min(plans.length, 3)},1fr);gap:24px;align-items:center">
          ${plans.map((plan: any) => `
          <div style="text-align:center;padding:32px;border:${plan.highlighted ? '2px solid #3B82F6' : '1px solid #E5E7EB'};border-radius:12px;${plan.highlighted ? 'transform:scale(1.05);box-shadow:0 8px 24px rgba(59,130,246,0.2)' : ''}">
            ${plan.highlighted ? '<div style="background:#3B82F6;color:#FFFFFF;padding:4px 16px;border-radius:12px;font-size:12px;font-weight:600;display:inline-block;margin-bottom:16px">推荐</div>' : ''}
            <h4 style="color:${p.textColor || '#1F2937'};font-size:20px;margin-bottom:8px">${escapeHtml(plan.name)}</h4>
            <div style="font-size:36px;font-weight:700;color:#3B82F6;margin-bottom:24px">${escapeHtml(plan.price)}</div>
            <div style="text-align:left;margin-bottom:24px">
              ${(plan.features || []).map((f: string) => `<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><span style="color:#10B981">✓</span><span style="color:#4B5563;font-size:14px">${escapeHtml(f)}</span></div>`).join('')}
            </div>
            <a href="#" style="display:block;padding:12px;background:${plan.highlighted ? '#3B82F6' : '#FFFFFF'};color:${plan.highlighted ? '#FFFFFF' : '#3B82F6'};border:${plan.highlighted ? 'none' : '1px solid #3B82F6'};border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(plan.ctaText)}</a>
          </div>`).join('')}
        </div>
      </div>
    </section>`;
    }

    case 'faq': {
      const items = p.items || [];
      return `
    <section style="background-color:${p.backgroundColor || '#FFFFFF'};color:${p.textColor || '#1F2937'};padding:${p.padding || 60}px 24px">
      <div style="max-width:720px;margin:0 auto">
        <h2 style="color:${p.textColor || '#1F2937'};text-align:center;margin-bottom:40px;font-size:28px">${escapeHtml(p.title)}</h2>
        ${items.map((item: any) => `
        <details style="border:1px solid #E5E7EB;border-radius:8px;margin-bottom:8px;padding:16px 20px">
          <summary style="font-weight:600;cursor:pointer;font-size:15px;color:${p.textColor || '#1F2937'}">${escapeHtml(item.question)}</summary>
          <p style="color:#6B7280;font-size:14px;line-height:1.8;margin-top:12px">${escapeHtml(item.answer)}</p>
        </details>`).join('')}
      </div>
    </section>`;
    }

    case 'testimonials': {
      const testimonials = p.testimonials || [];
      return `
    <section style="background-color:${p.backgroundColor || '#F0F4FF'};color:${p.textColor || '#1F2937'};padding:${p.padding || 60}px 24px;text-align:center">
      <div style="max-width:960px;margin:0 auto">
        <h2 style="color:${p.textColor || '#1F2937'};margin-bottom:48px;font-size:28px">${escapeHtml(p.title)}</h2>
        <div style="display:grid;grid-template-columns:repeat(${Math.min(testimonials.length, 3)},1fr);gap:24px">
          ${testimonials.map((t: any) => `
          <div style="text-align:left;padding:24px;border:1px solid #E5E7EB;border-radius:12px;background:#FFFFFF">
            <p style="color:#4B5563;font-size:15px;line-height:1.8;margin-bottom:20px">"${escapeHtml(t.content)}"</p>
            <div style="display:flex;align-items:center;gap:12px">
              <div style="width:40px;height:40px;border-radius:50%;background:#3B82F6;color:#FFFFFF;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600">${escapeHtml((t.name || '?').charAt(0))}</div>
              <div>
                <div style="font-weight:600;color:${p.textColor || '#1F2937'};font-size:14px">${escapeHtml(t.name)}</div>
                <div style="color:#9CA3AF;font-size:12px">${escapeHtml(t.company)}</div>
              </div>
            </div>
          </div>`).join('')}
        </div>
      </div>
    </section>`;
    }

    case 'cta':
      return `
    <section style="background-color:${p.backgroundColor || '#1E40AF'};color:${p.textColor || '#FFFFFF'};padding:${p.padding || 60}px 24px;text-align:center">
      <div style="max-width:640px;margin:0 auto">
        <h2 style="color:${p.textColor || '#FFFFFF'};margin-bottom:16px;font-size:28px">${escapeHtml(p.title)}</h2>
        <p style="color:${p.textColor || '#FFFFFF'};margin-bottom:32px;font-size:16px;opacity:0.9">${escapeHtml(p.description)}</p>
        <a href="${p.buttonLink || '#'}" style="display:inline-block;padding:12px 32px;border:2px solid ${p.textColor || '#FFFFFF'};color:${p.textColor || '#FFFFFF'};text-decoration:none;border-radius:8px;font-size:16px;font-weight:600">${escapeHtml(p.buttonText)}</a>
      </div>
    </section>`;

    case 'footer': {
      const links = p.links || [];
      const socialLinks = p.socialLinks || [];
      return `
    <footer style="background-color:${p.backgroundColor || '#111827'};color:${p.textColor || '#9CA3AF'};padding:${p.padding || 40}px 24px">
      <div style="max-width:960px;margin:0 auto">
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:32px;margin-bottom:32px">
          <div style="max-width:300px">
            <div style="color:#F9FAFB;font-size:18px;font-weight:600;margin-bottom:8px">${escapeHtml(p.companyName)}</div>
            <p style="color:${p.textColor || '#9CA3AF'};font-size:14px;line-height:1.6">${escapeHtml(p.description)}</p>
          </div>
          <div style="display:flex;gap:48px">
            ${links.length > 0 ? `
            <div>
              <div style="color:#F9FAFB;font-weight:600;margin-bottom:12px;font-size:14px">快速链接</div>
              ${links.map((l: any) => `<div style="margin-bottom:8px"><a href="${l.href || '#'}" style="color:${p.textColor || '#9CA3AF'};font-size:14px;text-decoration:none">${escapeHtml(l.label)}</a></div>`).join('')}
            </div>` : ''}
            ${socialLinks.length > 0 ? `
            <div>
              <div style="color:#F9FAFB;font-weight:600;margin-bottom:12px;font-size:14px">关注我们</div>
              ${socialLinks.map((l: any) => `<div style="margin-bottom:8px"><a href="${l.href || '#'}" style="color:${p.textColor || '#9CA3AF'};font-size:14px;text-decoration:none">${escapeHtml(l.platform)}</a></div>`).join('')}
            </div>` : ''}
          </div>
        </div>
        <div style="border-top:1px solid #374151;padding-top:20px;text-align:center">
          <span style="color:${p.textColor || '#9CA3AF'};font-size:13px">${escapeHtml(p.copyright)}</span>
        </div>
      </div>
    </footer>`;
    }

    default:
      return '';
  }
}

/** 生成完整站点 HTML（未注入统计脚本）。 */
export function generateHtml(blocks: SiteBlock[], siteName: string = '我的网站'): string {
  const blocksHtml = (Array.isArray(blocks) ? blocks : [])
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map(generateBlockHtml)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(siteName)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }
    a { transition: opacity 0.2s; }
    a:hover { opacity: 0.8; }
    details summary::-webkit-details-marker { display: none; }
    details summary::before { content: '+ '; font-weight: bold; }
    details[open] summary::before { content: '- '; }
    @media (max-width: 768px) {
      div[style*="grid-template-columns"] { grid-template-columns: 1fr !important; }
    }
  </style>
</head>
<body>
${blocksHtml}
</body>
</html>`;
}

/**
 * 注入统计脚本到 </body> 前。
 * @param html 生成后的完整 HTML
 * @param cloudBase 云端公开基地址（如 https://report.jlyl.net.cn）
 * @param siteId 站点 ID
 */
export function injectAnalyticsScript(html: string, cloudBase: string, siteId: number): string {
  const base = (cloudBase || '').replace(/\/$/, '');
  // 云端 Nginx 仅将 /api/* 反向代理到后端（3002），统计脚本必须带 /api 前缀，否则会被路由到前端
  const scriptTag = `<script async src="${base}/api/sites-analytics/analytics.js" data-site="${siteId}"></script>`;
  if (html.includes('</body>')) {
    return html.replace('</body>', `${scriptTag}\n</body>`);
  }
  return `${html}\n${scriptTag}`;
}