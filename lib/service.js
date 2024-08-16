import axios from "axios";

async function getData(userId) {
    const {data: user} = await axios("https://jsonplaceholder.typicode.com/users/1");
    const {data: posts} = await axios("https://jsonplaceholder.typicode.com/posts?userId=1");

    console.log("user", user);
    console.log("posts", posts);
}

export default getData;