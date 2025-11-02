// server.ts
import { serve } from 'bun';
import { JSDOM } from 'jsdom';

// Types
interface VideoData {
  id: string;
  code: string;
  title: string;
  thumbnail: string;
  duration: string;
  quality: string;
  videoUrl?: string;
}

/**
 * Helper function to make the authenticated POST request to the CDN endpoint.
 * @param {string} videoId - The ID of the video.
 * @param {string} csrfToken - The CSRF token from the video page.
 * @param {string} cookieString - The session cookie string.
 * @returns {Promise<string | null>} - The CDN URL or null on failure.
 */
async function getVideoCdnUrl(videoId: string, csrfToken: string, cookieString: string): Promise<string | null> {
  if (!csrfToken || !cookieString) {
    console.error('CSRF token or cookie is missing.');
    return null;
  }

  try {
    const formData = new FormData();
    formData.append('video_id', videoId);
    formData.append('pid_c', '');
    formData.append('token', csrfToken);

    const response = await fetch('https://javtiful.com/ajax/get_cdn', {
      method: 'POST',
      headers: {
        // The cookie is crucial for authentication.
        'Cookie': cookieString,
        'Referer': `https://javtiful.com/video/${videoId}`,
        'Origin': 'https://javtiful.com',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'DNT': '1',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        // NOTE: Do NOT set the 'Content-Type' header. Bun's fetch API
        // sets it automatically with the correct boundary when you use FormData.
      },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const responseText = await response.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (parseError) {
      console.error('Failed to parse response body as JSON:', parseError);
      console.error('Raw response body:', responseText);
      return null;
    }

    return data.playlists || null;

  } catch (error) {
    console.error(`Error getting CDN URL for video ${videoId}:`, error);
    return null;
  }
}

/**
 * Helper function to extract video data from the main page.
 * @returns {Promise<VideoData[]>}
 */
async function extractVideoDataFromMainPage(): Promise<VideoData[]> {
  try {
    const response = await fetch('https://javtiful.com/main');
    const html = await response.text();
    const dom = new JSDOM(html);
    const document = dom.window.document;
    const videoCards = document.querySelectorAll('.col.pb-3 .card');
    const videos: VideoData[] = [];

    videoCards.forEach(card => {
      try {
        const linkElement = card.querySelector('a.video-tmb');
        if (!linkElement) return;
        const href = linkElement.getAttribute('href');
        if (!href) return;
        const idMatch = href.match(/\/video\/(\d+)\//);
        if (!idMatch) return;
        const videoId = idMatch[1];
        const imgElement = linkElement.querySelector('img');
        const thumbnail = imgElement?.getAttribute('data-src') || imgElement?.getAttribute('src') || '';
        const hdLabel = linkElement.querySelector('.label-hd')?.textContent || '';
        const duration = linkElement.querySelector('.label-duration')?.textContent || '';
        const code = linkElement.querySelector('.label-code')?.textContent || '';
        const titleLink = card.querySelector('.video-link');
        const title = titleLink?.getAttribute('title') || titleLink?.textContent || '';

        videos.push({
          id: videoId,
          code,
          title,
          thumbnail,
          duration,
          quality: hdLabel,
        });
      } catch (error) {
        console.error('Error parsing video card:', error);
      }
    });

    return videos;
  } catch (error) {
    console.error('Error fetching main page:', error);
    return [];
  }
}

// Start the server
const server = serve({
  port: 8080,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // API route to get a list of videos
    if (url.pathname === '/api/videos') {
      try {
        const videos = await extractVideoDataFromMainPage();
        return new Response(JSON.stringify(videos), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: 'Failed to fetch videos' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // API route to get the streaming URL for a specific video
    if (url.pathname === '/api/video-url' && req.method === 'POST') {
      try {
        const body = await req.json();
        const { videoId } = body;

        if (!videoId) {
          return new Response(JSON.stringify({ error: 'Video ID is required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        console.log(`[1/3] Fetching page for videoId: ${videoId}`);
        const pageResponse = await fetch(`https://javtiful.com/video/${videoId}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
            }
        });

        if (!pageResponse.ok) {
            throw new Error(`Failed to fetch video page: ${pageResponse.status} ${pageResponse.statusText}`);
        }

        const html = await pageResponse.text();
        const dom = new JSDOM(html);
        const document = dom.window.document;

        // 1. Extract CSRF token from the page HTML
        const token = document.getElementById('token_full')?.getAttribute('data-csrf-token');
        if (!token) {
          throw new Error('Could not find CSRF token on the page.');
        }

        // 2. Extract cookies from the response headers
        const setCookieHeader = pageResponse.headers.get('set-cookie');
        if (!setCookieHeader) {
          throw new Error('Could not find cookies in the response headers.');
        }
        const cookies = setCookieHeader.split(',').map(cookie => cookie.split(';')[0]).join('; ');
        
        console.log(`[2/3] Successfully extracted token and cookies.`);

        // 3. Use the extracted information to get the CDN URL
        const videoUrl = await getVideoCdnUrl(videoId, token, cookies);

        if (!videoUrl) {
          return new Response(JSON.stringify({ error: 'Failed to get video URL from CDN endpoint' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        console.log(`[3/3] ✅ Success! Got video URL for ${videoId}.`);
        return new Response(JSON.stringify({ videoUrl }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (error) {
        console.error(`An error occurred in /api/video-url:`, error);
        return new Response(JSON.stringify({ error: 'Failed to fetch video URL' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // Default response
    return new Response('Not found', { status: 404 });
  },
});

console.log(`Server running at http://localhost:${server.port}`);