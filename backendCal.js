import axios from 'axios';

const data = {
  name: 'Abd',
  email: 'alice@example.com'
};

try {
  const response = await axios.post('http://localhost:3000/users', data);
  console.log('Response from Server B:', response.data);
} catch (error) {
  console.error('Error sending data:', error.message);
}
