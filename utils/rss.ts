import { PodcastEpisode } from '../types';

export function generateRSSFeed(
  episodes: PodcastEpisode[], 
  baseUrl: string, 
  ownerEmail: string = 'broadcast@sundaramlabs.ai'
): string {
  const lastBuildDate = new Date().toUTCString();
  
  const items = episodes
    .map(e => {
      const storyList = e.mainStories && e.mainStories.length > 0 
        ? `<p><strong>Intelligence Brief:</strong></p><ul>${e.mainStories.map(s => `<li>${s}</li>`).join('')}</ul><hr/>`
        : '';
      
      const audioLink = e.audioUrl.startsWith('http') 
        ? e.audioUrl 
        : `${baseUrl.replace(/\/$/, '')}/${e.audioUrl.replace(/^\//, '')}`;
        
      const formattedScript = e.script.replace(/\n/g, '<br/>');

      return `
    <item>
      <title>${e.title}</title>
      <description><![CDATA[${storyList}<p>${e.script.substring(0, 500)}...</p>]]></description>
      <content:encoded><![CDATA[${storyList}${formattedScript}]]></content:encoded>
      <pubDate>${new Date(e.date).toUTCString()}</pubDate>
      <guid isPermaLink="false">${e.id}</guid>
      <enclosure url="${audioLink}" length="0" type="audio/mpeg"/>
      <itunes:author>AI Daily Pulse</itunes:author>
      <itunes:duration>15:00</itunes:duration>
      <itunes:explicit>no</itunes:explicit>
    </item>`;
    }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>AI Daily Pulse</title>
    <link>${baseUrl}</link>
    <language>en-us</language>
    <itunes:author>Sundaram Labs</itunes:author>
    <itunes:summary>Your daily 15-minute conversational deep dive into latest AI developments. Optimized 10-12 word summaries.</itunes:summary>
    <description>Automated daily AI intelligence briefing.</description>
    <itunes:owner>
      <itunes:name>Sundaram Labs</itunes:name>
      <itunes:email>${ownerEmail}</itunes:email>
    </itunes:owner>
    <itunes:explicit>no</itunes:explicit>
    <itunes:category text="Technology"/>
    <itunes:image href="${baseUrl}/cover.jpg"/>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
    ${items}
  </channel>
</rss>`;
}
