Create a interactive visualization of systems design for a web service. Goal here is to be educational.

It should simulate real traffic, and the user should be able to adjust the amount of traffic. The flow of traffic should be visualized. The user can read real-time metrics on the system. The user can increase traffic for example revealing bottlenecks, and possibly breaking the system (eg. blowing something up).

User should be able to zoom into any part of a system. For example, viewing the core parts of a computer server, specifically CPU, memory, storage, and network bandwidth

# Notes
- Should be able to see a system diagram of different components of a basic systems architecture. So a client, web server, and database. Optionally could add a Kafka stream, and maybe a queue as well.
- Should be able to zoom into any component of the system by clicking on it
- We want to be able to visualize different throughput rates, for example to the database
- Being able to visualize Kafka streams and database throughput would be nice too
- Would also be nice to be able to visualize different levels of load on the servers and/or database. User can customize this level, for example to increase traffic until the system breaks.
- Should be able to view real-time metrics on the system. For example, CPU utilization, memory usage, storage space.

# Tech Stack
- You can use Three.js, and a build tool like Vite


Add a Data Lake with S3 + Iceberg + Parquet. Also add ClickHouse, and whatever analytic system that might entail.

Currently the data flow visualization only shows data from the client towards our system components (eg. web server, database), but not back towards the client. We should show the flow in that direction as well.

The job queue should show number of jobs.

The stream consumer currently appears to be a sink, whereas in practice it would probably be doing something with the data and sending it to some sink. Update accordingly.

The user should be able to place new components (eg. web server), and wire up connections between components if it is sensible.

Database should use a specific database. For example, Postgres, MySQL, DynamoDb, BigTable, etc. We should also support ClickHouse, Snowflake, etc. We should differentiate between OLTP and OLAP databases.

We ideally want to visualize costs as well. We can estimate ballpark costs using public pricing on for example AWS or Google Cloud

We should have specific technologies for everything, and user should be able to customize the specific technology. For example, the web server could use EC2, Google Coud Run, a physical server, etc. The load balancer could be Nginx or something else.

Look up the possible specific technologies for each component, and make it possible to be each component.

- For cloud, only need to consider AWS and Google Cloud
- For specific technologies, show an appropriate logo (eg. Postgres logo) and/or visual.

---

For cache, show <memory usage / memory capacity> in GB or TB or whatever the metric is.

---

The user should be able to select from preset systems, like Youtube and Instagram
- Youtube https://www.hellointerview.com/learn/system-design/problem-breakdowns/youtube
- Instagram https://www.hellointerview.com/learn/system-design/problem-breakdowns/instagram
- Uber https://www.hellointerview.com/learn/system-design/problem-breakdowns/uber

---

When zooming in on a component (eg. AWS Athena), there should be a description telling me what the technology is