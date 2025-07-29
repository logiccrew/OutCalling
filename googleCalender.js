import { google } from 'googleapis';
 const  timeZone="Australia/Melburne"
 const email="moiz@gmail.com"

async function createEvent({ date }) {
    const auth = new google.auth.GoogleAuth({
      keyFile: 'credentials.json',
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
  
    const calendar = google.calendar({ version: 'v3', auth });
  
    const endTime = new Date(date.getTime() + duration * 60000); // add minutes
  
    await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: `Meeting with ${zain}`,
        description: `Booked by voice assistant. Email: ${email}`,
        start: {
          dateTime: date.toISOString(),
          timeZone,
        },
        end: {
          dateTime: endTime.toISOString(),
          timeZone,
        },
        attendees: [
          { email, displayName: name },
        ],
      },
    });
  
    console.log("📅 Google Calendar event created");
  }

  export default createEvent;