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