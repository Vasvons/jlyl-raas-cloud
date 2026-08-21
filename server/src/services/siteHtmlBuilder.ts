/**
 * 灵犀站点引擎 — 站点 HTML 唯一生成源（SITE_ENGINE_PLAN P1）
 *
 * 自桌面端 services/publishService.ts 移植 generateBlockHtml / generateHtml / escapeHtml，
 * 成为站点的唯一 HTML 生成逻辑，保证发布(OSS)与预览(/sites/:id/preview)同源、不漂移。
 *
 * 区块类型（BlockType）：hero / features / pricing / faq / testimonials / cta / footer /
 * header / about / team / stats / gallery / logos / newsletter / contact / steps / announcement / html
 * 与桌面端 components/Editor/types.ts 保持一致，后续扩充区块类型时需同步。
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

    case 'header': {
      const navItems = p.navItems || [];
      return `
    <header style="background-color:${p.backgroundColor || '#FFFFFF'};color:${p.textColor || '#1F2937'};padding:${p.padding || 16}px 24px;border-bottom:1px solid #E5E7EB">
      <div style="max-width:960px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <span style="font-size:18px;font-weight:700">${escapeHtml(p.siteName)}</span>
        ${navItems.length > 0 ? `<nav style="display:flex;gap:24px;flex-wrap:wrap">${navItems.map((item: any) => `<a href="${escapeHtml(item.href) || '#'}" style="color:${p.textColor || '#1F2937'};text-decoration:none;font-size:14px;font-weight:500">${escapeHtml(item.label)}</a>`).join('')}</nav>` : ''}
      </div>
    </header>`;
    }

    case 'about': {
      const points = p.points || [];
      return `
    <section style="background-color:${p.backgroundColor || '#FFFFFF'};color:${p.textColor || '#1F2937'};padding:${p.padding || 60}px 24px">
      <div style="max-width:960px;margin:0 auto;display:flex;gap:48px;align-items:center;flex-wrap:wrap">
        <div style="flex:1;min-width:260px">
          <h2 style="color:${p.textColor || '#1F2937'};margin-bottom:16px;font-size:28px">${escapeHtml(p.title)}</h2>
          <p style="color:${p.textColor || '#1F2937'};font-size:15px;line-height:1.8;opacity:0.9">${escapeHtml(p.description)}</p>
          ${points.length > 0 ? `<ul style="margin-top:16px;padding-left:20px">${points.map((point: any) => `<li style="color:${p.textColor || '#1F2937'};font-size:14px;line-height:2;opacity:0.85">${escapeHtml(point)}</li>`).join('')}</ul>` : ''}
        </div>
        ${p.image ? `<div style="flex:1;min-width:260px"><img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.title)}" style="width:100%;border-radius:12px;object-fit:cover"/></div>` : ''}
      </div>
    </section>`;
    }

    case 'team': {
      const members = p.members || [];
      const cols = Math.min(Math.max(members.length, 1), 4);
      return `
    <section style="background-color:${p.backgroundColor || '#FFFFFF'};color:${p.textColor || '#1F2937'};padding:${p.padding || 60}px 24px;text-align:center">
      <div style="max-width:960px;margin:0 auto">
        <h2 style="color:${p.textColor || '#1F2937'};margin-bottom:48px;font-size:28px">${escapeHtml(p.title)}</h2>
        <div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:24px">
          ${members.map((member: any) => `
          <div style="text-align:center;padding:24px;border:1px solid #E5E7EB;border-radius:12px">
            <div style="width:72px;height:72px;border-radius:50%;background:#3B82F6;color:#FFFFFF;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:24px;font-weight:600">${escapeHtml((member.name || '?').charAt(0))}</div>
            <h4 style="color:${p.textColor || '#1F2937'};font-size:18px;margin-bottom:4px">${escapeHtml(member.name)}</h4>
            <div style="color:#3B82F6;font-size:13px;margin-bottom:8px">${escapeHtml(member.role)}</div>
            <p style="color:#6B7280;font-size:13px">${escapeHtml(member.bio)}</p>
          </div>`).join('')}
        </div>
      </div>
    </section>`;
    }

    case 'stats': {
      const items = p.items || [];
      const cols = Math.min(Math.max(items.length, 1), 4);
      return `
    <section style="background-color:${p.backgroundColor || '#F0F4FF'};color:${p.textColor || '#1F2937'};padding:${p.padding || 60}px 24px;text-align:center">
      <div style="max-width:960px;margin:0 auto">
        <h2 style="color:${p.textColor || '#1F2937'};margin-bottom:48px;font-size:28px">${escapeHtml(p.title)}</h2>
        <div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:24px">
          ${items.map((item: any) => `
          <div>
            <div style="font-size:40px;font-weight:700;color:#3B82F6;margin-bottom:8px">${escapeHtml(item.value)}</div>
            <div style="color:${p.textColor || '#1F2937'};font-size:14px;opacity:0.85">${escapeHtml(item.label)}</div>
          </div>`).join('')}
        </div>
      </div>
    </section>`;
    }

    case 'gallery': {
      const images = p.images || [];
      return `
    <section style="background-color:${p.backgroundColor || '#F9FAFB'};color:#1F2937;padding:${p.padding || 60}px 24px;text-align:center">
      <div style="max-width:960px;margin:0 auto">
        <h2 style="color:#1F2937;margin-bottom:48px;font-size:28px">${escapeHtml(p.title)}</h2>
        ${images.length > 0 ? `<div style="display:grid;grid-template-columns:repeat(${p.columns || 3},1fr);gap:16px">${images.map((src: string) => `<img src="${escapeHtml(src)}" alt="" style="width:100%;height:180px;object-fit:cover;border-radius:12px"/>`).join('')}</div>` : ''}
      </div>
    </section>`;
    }

    case 'logos': {
      const names = p.names || [];
      return `
    <section style="background-color:${p.backgroundColor || '#FFFFFF'};color:#1F2937;padding:${p.padding || 40}px 24px;text-align:center">
      <div style="max-width:960px;margin:0 auto">
        <h2 style="color:#1F2937;margin-bottom:32px;font-size:24px">${escapeHtml(p.title)}</h2>
        ${names.length > 0 ? `<div style="display:flex;flex-wrap:wrap;gap:24px;justify-content:center">${names.map((name: string) => `<div style="padding:12px 24px;border:1px solid #E5E7EB;border-radius:8px;color:#6B7280;font-size:16px;font-weight:600;background:#F9FAFB">${escapeHtml(name)}</div>`).join('')}</div>` : ''}
      </div>
    </section>`;
    }

    case 'newsletter':
      return `
    <section style="background-color:${p.backgroundColor || '#1E40AF'};color:${p.textColor || '#FFFFFF'};padding:${p.padding || 60}px 24px;text-align:center">
      <div style="max-width:560px;margin:0 auto">
        <h2 style="color:${p.textColor || '#FFFFFF'};margin-bottom:12px;font-size:28px">${escapeHtml(p.title)}</h2>
        <p style="color:${p.textColor || '#FFFFFF'};font-size:15px;margin-bottom:24px;opacity:0.9">${escapeHtml(p.description)}</p>
        <form style="display:flex;gap:8px" onsubmit="return false">
          <input type="email" placeholder="${escapeHtml(p.placeholder)}" style="flex:1;padding:10px 14px;border:none;border-radius:8px;font-size:14px" />
          <button type="submit" style="padding:10px 24px;background:${p.textColor === '#FFFFFF' ? '#FFFFFF' : '#1677ff'};color:${p.textColor === '#FFFFFF' ? (p.backgroundColor || '#1E40AF') : '#FFFFFF'};border:none;border-radius:8px;font-weight:600;cursor:pointer">${escapeHtml(p.buttonText)}</button>
        </form>
      </div>
    </section>`;

    case 'contact': {
      const contactItems = [
        { label: '电话', value: p.phone },
        { label: '邮箱', value: p.email },
        { label: '地址', value: p.address },
      ].filter((item: any) => item.value);
      return `
    <section style="background-color:${p.backgroundColor || '#FFFFFF'};color:${p.textColor || '#1F2937'};padding:${p.padding || 60}px 24px">
      <div style="max-width:720px;margin:0 auto">
        <h2 style="color:${p.textColor || '#1F2937'};text-align:center;margin-bottom:12px;font-size:28px">${escapeHtml(p.title)}</h2>
        <p style="color:${p.textColor || '#1F2937'};text-align:center;font-size:15px;margin-bottom:32px;opacity:0.9">${escapeHtml(p.description)}</p>
        ${contactItems.length > 0 ? `<div style="display:flex;flex-wrap:wrap;gap:24px;justify-content:center;margin-bottom:32px">${contactItems.map((item: any) => `<div style="text-align:center"><div style="color:#3B82F6;font-size:12px;margin-bottom:4px">${escapeHtml(item.label)}</div><div style="color:${p.textColor || '#1F2937'};font-size:14px;font-weight:500">${escapeHtml(item.value)}</div></div>`).join('')}</div>` : ''}
        <form style="max-width:480px;margin:0 auto;display:flex;flex-direction:column;gap:12px" onsubmit="return false">
          <input placeholder="您的姓名" style="padding:10px 14px;border:1px solid #D1D5DB;border-radius:8px;font-size:14px" />
          <input placeholder="您的联系方式" style="padding:10px 14px;border:1px solid #D1D5DB;border-radius:8px;font-size:14px" />
          <textarea placeholder="留言内容" rows="3" style="padding:10px 14px;border:1px solid #D1D5DB;border-radius:8px;font-size:14px"></textarea>
          <button type="submit" style="padding:12px;background:#1677ff;color:#FFFFFF;border:none;border-radius:8px;font-weight:600;cursor:pointer">${escapeHtml(p.buttonText)}</button>
        </form>
      </div>
    </section>`;
    }

    case 'steps': {
      const items = p.items || [];
      const cols = Math.min(Math.max(items.length, 1), 4);
      return `
    <section style="background-color:${p.backgroundColor || '#FFFFFF'};color:${p.textColor || '#1F2937'};padding:${p.padding || 60}px 24px">
      <div style="max-width:960px;margin:0 auto">
        <h2 style="color:${p.textColor || '#1F2937'};text-align:center;margin-bottom:48px;font-size:28px">${escapeHtml(p.title)}</h2>
        <div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:24px">
          ${items.map((item: any, i: number) => `
          <div style="text-align:center;padding:24px">
            <div style="width:48px;height:48px;border-radius:50%;background:#3B82F6;color:#FFFFFF;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:20px;font-weight:700">${i + 1}</div>
            <h4 style="color:${p.textColor || '#1F2937'};font-size:17px;margin-bottom:8px">${escapeHtml(item.title)}</h4>
            <p style="color:#6B7280;font-size:14px">${escapeHtml(item.description)}</p>
          </div>`).join('')}
        </div>
      </div>
    </section>`;
    }

    case 'announcement':
      return `
    <div style="background-color:${p.backgroundColor || '#FEF3C7'};color:${p.textColor || '#92400E'};padding:${p.padding || 24}px 24px;border-bottom:1px solid #FDE68A">
      <div style="max-width:960px;margin:0 auto;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <strong style="color:${p.textColor || '#92400E'};font-size:14px">${escapeHtml(p.title)}</strong>
        <span style="color:${p.textColor || '#92400E'};font-size:14px;opacity:0.9">${escapeHtml(p.content)}</span>
      </div>
    </div>`;

    case 'html':
      // AI 整页 HTML（高级模式）：内容原样透传，不做转义
      return p.html || '';

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