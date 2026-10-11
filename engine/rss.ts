import { ShowConfig, EpisodeRecord } from './types.js';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function generateRSSFeed(episodes: EpisodeRecord[], cfg: ShowConfig, baseUrl: string): string {
  const lastBuildDate = new Date().toUTCString();
  const cleanBase = baseUrl.replace(/\/$/, '');

  const items = episodes
    .map((e) => {
      const storyList =
        e.mainStories && e.mainStories.length > 0
          ? `<p><strong>Brief:</strong></p><ul>${e.mainStories.map((s) => `<li>${esc(s)}</li>`).join('')}</ul><hr/>`
          : '';
      const audioLink = e.audioUrl.startsWith('http') ? e.audioUrl : `${cleanBase}/${e.audioUrl.replace(/^\//, '')}`;
      const formattedScript = esc(e.script).replace(/\n/g, '<br/>');
      return `
    <item>
      <title>${esc(e.title)}</title>
      <description><![CDATA[${storyList}<p>${esc(e.script.substring(0, 500))}...</p>]]></description>
      <content:encoded><![CDATA[${storyList}${formattedScript}]]></content:encoded>
      <pubDate>${new Date(e.date).toUTCString()}</pubDate>
      <guid isPermaLink="false">${esc(e.id)}</guid>
      <enclosure url="${esc(audioLink)}" length="0" type="audio/mpeg"/>
      <itunes:author>${esc(cfg.feedTitle)}</itunes:author>
      <itunes:duration>${cfg.targetMinutes}:00</itunes:duration>
      <itunes:explicit>no</itunes:explicit>
    </item>`;
    })
    .join('');

  const categories = cfg.categories.map((c) => `    <itunes:category text="${esc(c)}"/>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${esc(cfg.feedTitle)}</title>
    <link>${cleanBase}</link>
    <language>${esc(cfg.language)}</language>
    <itunes:author>${esc(cfg.author)}</itunes:author>
    <itunes:summary>${esc(cfg.summary)}</itunes:summary>
    <description>${esc(cfg.description)}</description>
    <itunes:owner>
      <itunes:name>${esc(cfg.author)}</itunes:name>
      <itunes:email>${esc(cfg.email)}</itunes:email>
    </itunes:owner>
    <itunes:explicit>no</itunes:explicit>
${categories}
    <itunes:image href="${cleanBase}/${esc(cfg.coverFile)}"/>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
    ${items}
  </channel>
</rss>`;
}
